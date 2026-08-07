import os from 'node:os';
import process from 'node:process';
import pty from 'node-pty';
import { keyToBytes, sleep } from './keys.js';

export class PtySession {
  constructor(opts = {}) {
    this.shell = opts.shell || defaultShell();
    this.cwd = opts.cwd || process.cwd();
    this.cols = process.stdout.columns || 120;
    this.rows = process.stdout.rows || 40;
    this.buffer = '';
    this.maxBuffer = 250_000;
    this.term = null;
    this.exited = false;
    this.exitCode = null;
  }

  start() {
    if (!process.stdout.isTTY) {
      throw new Error('gex needs a real Ghostty TTY');
    }

    this.term = pty.spawn(this.shell, ['-l', '-i'], {
      name: process.env.TERM || 'xterm-ghostty',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: {
        ...process.env,
        GEX_AUTOPILOT: '1',
        // Keep Ghostty identity for greeting/chafa paths inside the child
        TERM_PROGRAM: process.env.TERM_PROGRAM || 'ghostty',
      },
    });

    this.term.onData((data) => {
      this.buffer += data;
      if (this.buffer.length > this.maxBuffer) {
        this.buffer = this.buffer.slice(-this.maxBuffer);
      }
      process.stdout.write(data);
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

  async submit(line) {
    await this.type(String(line));
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
  if (process.env.SHELL) return process.env.SHELL;
  if (os.platform() === 'darwin') return '/opt/homebrew/bin/fish';
  return '/bin/bash';
}
