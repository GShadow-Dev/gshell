import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import pty from 'node-pty';
import { keyToBytes, sleep } from './keys.js';
import { TermQueryFilter } from './term_queries.js';

const require = createRequire(import.meta.url);

function ensureSpawnHelperExecutable() {
  try {
    const ptyPkg = path.dirname(require.resolve('node-pty/package.json'));
    const pre = path.join(ptyPkg, 'prebuilds');
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (name === 'spawn-helper') fs.chmodSync(p, 0o755);
      }
    };
    walk(pre);
  } catch {
    /* ignore */
  }
}

function resolveShell() {
  const candidates = [
    process.env.SHELL,
    '/opt/homebrew/bin/fish',
    '/usr/local/bin/fish',
    '/bin/zsh',
    '/bin/bash',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return '/bin/bash';
}

/** Env for the driven shell — no Ghostty integration, no greeting noise. */
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || v === null) continue;
    // Drop Ghostty shell-integration injection so the child does not probe us
    if (k.startsWith('GHOSTTY_')) continue;
    if (k === 'TERMINFO' && String(v).includes('ghostty')) continue;
    env[k] = String(v);
  }
  env.GEX_AUTOPILOT = '1';
  // Standard xterm — fewer proprietary probes than xterm-ghostty
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  // Keep TERM_PROGRAM for tools that check it, but integration vars are gone
  env.TERM_PROGRAM = 'gex';
  env.TERM_PROGRAM_VERSION = '0.1.0';
  // Silence fish greeting inside autopilot session
  env.fish_greeting = '';
  return env;
}

export class PtySession {
  constructor(opts = {}) {
    this.shell = opts.shell || resolveShell();
    this.cwd = opts.cwd || process.cwd();
    this.cols = process.stdout.columns || 120;
    this.rows = process.stdout.rows || 40;
    this.buffer = '';
    this.maxBuffer = 250_000;
    this.term = null;
    this.exited = false;
    this.exitCode = null;
    this._filter = null;
    this._outputListeners = new Set();
  }

  /** Subscribe to displayable output chunks. Returns unsubscribe. */
  onOutput(fn) {
    this._outputListeners.add(fn);
    return () => this._outputListeners.delete(fn);
  }
  start() {
    if (!process.stdout.isTTY) {
      throw new Error('gex needs a real Ghostty TTY');
    }
    ensureSpawnHelperExecutable();
    if (!fs.existsSync(this.shell)) {
      throw new Error(`shell not found: ${this.shell}`);
    }

    const env = childEnv();

    this.term = pty.spawn(this.shell, ['-i'], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    });

    this._filter = new TermQueryFilter((bytes) => {
      try {
        this.term.write(bytes);
      } catch {
        /* ignore */
      }
    });

    this.term.onData((data) => {
      const display = this._filter.push(data);
      this.buffer += display;
      if (this.buffer.length > this.maxBuffer) {
        this.buffer = this.buffer.slice(-this.maxBuffer);
      }
      if (display) process.stdout.write(display);
      for (const fn of this._outputListeners) {
        try {
          fn(display, this.buffer);
        } catch {
          /* ignore listener errors */
        }
      }
    });

    this.term.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
    });

    this._onResize = () => {
      this.cols = process.stdout.columns || this.cols;
      this.rows = process.stdout.rows || this.rows;
      try {
        this.term.resize(this.cols, this.rows);
      } catch {
        /* ignore */
      }
    };
    process.stdout.on('resize', this._onResize);

    // Prime: disable fish greeting if still active
    setTimeout(() => {
      try {
        // Clear any half-open probe state and show a clean prompt
        this.term.write('\x15'); // ctrl-u
      } catch {
        /* ignore */
      }
    }, 50);

    return this;
  }

  screenText(n = 7000) {
    return stripAnsi(this.buffer).slice(-n);
  }

  async type(text, { delayMs = 0 } = {}) {
    if (delayMs <= 0) {
      this.term.write(text);
      return;
    }
    for (const ch of text) {
      this.term.write(ch);
      await sleep(delayMs);
    }
  }

  async key(name) {
    this.term.write(keyToBytes(name));
  }

  /**
   * Submit a shell command.
   * Multi-line / heredoc → write a temp bash script and run it (fish interactive
   * binds and quoting are hostile to bash-style heredocs typed live).
   */
  async submit(line) {
    const s = String(line ?? '');
    if (!s.trim()) {
      await this.key('enter');
      return;
    }

    const multiline =
      s.includes('\n') ||
      /<<\s*['-]?\w+/.test(s) ||
      /<<\s*\\?\w+/.test(s);

    if (multiline) {
      const tmp = path.join(
        os.tmpdir(),
        `gex-run-${process.pid}-${Date.now()}.sh`,
      );
      const body = s.endsWith('\n') ? s : `${s}\n`;
      fs.writeFileSync(tmp, body, { mode: 0o700 });
      // bash runs the script; always rm. Quote path for fish.
      const q = `'${tmp.replace(/'/g, `'\\''`)}'`;
      await this.type(`bash ${q}; rm -f ${q}`);
      await this.key('enter');
      return;
    }

    await this.type(s);
    await this.key('enter');
  }

  async waitFor({ pattern = null, quietMs = 500, timeoutMs = 60_000 } = {}) {
    const start = Date.now();
    let lastLen = this.buffer.length;
    let lastChange = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.exited) return { ok: false, reason: 'exited' };
      if (this.buffer.length !== lastLen) {
        lastLen = this.buffer.length;
        lastChange = Date.now();
      }
      const text = this.screenText();
      if (pattern) {
        const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
        if (re.test(text)) return { ok: true, reason: 'pattern' };
      } else if (Date.now() - lastChange >= quietMs) {
        return { ok: true, reason: 'quiet' };
      }
      await sleep(40);
    }
    return { ok: false, reason: 'timeout' };
  }

  async dispose() {
    process.stdout.off('resize', this._onResize);
    if (this.term && !this.exited) {
      try {
        this.term.write('\x03');
        await sleep(60);
        this.term.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

export function stripAnsi(s) {
  return String(s)
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[PX^_].*?\u001b\\/g, '')
    .replace(/\r/g, '');
}

export function defaultShell() {
  return resolveShell();
}
