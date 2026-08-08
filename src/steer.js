import process from 'node:process';

/**
 * Local typing never goes to the driven PTY.
 * Type + Enter → STEER. Ctrl-C → shell interrupt. Ctrl-C×2 → abort gex.
 *
 * Filters terminal protocol noise (DCS/OSC/CSI — e.g. Ghostty `P>|ghostty…`)
 * so it never lands in the steer buffer.
 */
export class SteerInput {
  constructor({ onSteer, onInterrupt, onAbort }) {
    this.onSteer = onSteer;
    this.onInterrupt = onInterrupt;
    this.onAbort = onAbort;
    this.buf = '';
    this._pending = ''; // unparsed raw
    this.lastSigint = 0;
    this.active = false;
    this._onData = (chunk) => this._handle(chunk);
    this._repaint = null;
  }

  start() {
    if (!process.stdin.isTTY) return;
    this.active = true;
    try {
      process.stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
    process.stdin.resume();
    // binary so we can parse escapes cleanly
    process.stdin.setEncoding(null);
    process.stdin.on('data', this._onData);
    this._repaint = setInterval(() => this._paint(), 120);
    this._repaint.unref?.();
    this._paint();
  }

  stop() {
    this.active = false;
    clearInterval(this._repaint);
    this._repaint = null;
    if (!process.stdin.isTTY) return;
    process.stdin.off('data', this._onData);
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    this._clearLine();
  }

  _handle(chunk) {
    if (!this.active) return;
    const s =
      typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString('latin1')
          : String(chunk);
    this._pending += s;

    // Process pending into events / printable
    while (this._pending.length) {
      const c0 = this._pending[0];

      // ESC sequences — drop complete ones; wait if incomplete
      if (c0 === '\x1b') {
        const drop = takeEscape(this._pending);
        if (drop === null) return; // need more bytes
        this._pending = this._pending.slice(drop);
        continue;
      }

      // bare DCS leftovers like "P>|ghostty 1.3.1\"
      if (
        this._pending.startsWith('P>|') ||
        this._pending.startsWith(']11;') ||
        this._pending.startsWith(']10;')
      ) {
        // eat until BEL, ST, or newline
        const m = this._pending.match(/^(?:P>\|[^\x07\x1b\r\n]*|\][^\x07\x1b\r\n]*)/);
        if (m) {
          this._pending = this._pending.slice(m[0].length);
          if (this._pending[0] === '\x07') this._pending = this._pending.slice(1);
          continue;
        }
      }

      const ch = this._pending[0];
      this._pending = this._pending.slice(1);

      if (ch === '\x03') {
        // Ctrl-C
        const now = Date.now();
        if (now - this.lastSigint < 900) {
          this.onAbort?.();
          return;
        }
        this.lastSigint = now;
        this.buf = '';
        this._paint();
        this.onInterrupt?.();
        continue;
      }

      if (ch === '\x04') continue; // ctrl-d
      if (ch === '\x0c') {
        this.buf = '';
        this._paint();
        continue;
      }

      if (ch === '\r' || ch === '\n') {
        const msg = sanitizeSteer(this.buf);
        this.buf = '';
        this._paint();
        if (msg) this.onSteer?.(msg);
        continue;
      }

      if (ch === '\x7f' || ch === '\b') {
        this.buf = this.buf.slice(0, -1);
        this._paint();
        continue;
      }

      // printable ASCII + common unicode (latin1 high bytes decoded later as utf8-ish)
      if (ch >= ' ' && ch !== '\x7f') {
        this.buf += ch;
        this._dirty = true;
        if (this.buf.length > 500) this.buf = this.buf.slice(0, 500);
        // auto-drop protocol junk if it snuck in
        if (/P>\|ghostty|^\s*P>\|/.test(this.buf)) {
          this.buf = '';
        }
        this._paint();
      }
    }
  }

  _paint() {
    if (!this.active || !process.stderr.isTTY) return;
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const label = 'steer› ';
    const room = Math.max(8, cols - label.length - 1);
    const shown = this.buf.slice(-room);
    const line = `${label}${shown}`;
    const pad = ' '.repeat(Math.max(0, cols - [...line].length - 1));
    const row = Math.max(1, rows - 1);
    process.stderr.write(
      `\x1b7\x1b[${row};1H\x1b[48;2;18;10;28m\x1b[38;2;255;180;84m${line}${pad}\x1b[0m\x1b8`,
    );
  }

  _clearLine() {
    if (!process.stderr.isTTY) return;
    const rows = process.stdout.rows || 24;
    const row = Math.max(1, rows - 1);
    process.stderr.write(`\x1b7\x1b[${row};1H\x1b[2K\x1b8`);
  }
}

/** @returns {number|null} bytes to drop, or null if incomplete */
function takeEscape(s) {
  if (s[0] !== '\x1b') return 0;
  if (s.length < 2) return null;

  const n1 = s[1];

  // CSI: ESC [ ... finalbyte
  if (n1 === '[') {
    const m = s.match(/^\x1b\[[0-9;:?]*[ -/]*[@-~]/);
    if (m) return m[0].length;
    if (s.length > 64) return 2; // give up
    return null;
  }

  // OSC: ESC ] ... BEL or ST
  if (n1 === ']') {
    const bel = s.indexOf('\x07');
    const st = s.indexOf('\x1b\\');
    if (bel > 0) return bel + 1;
    if (st > 0) return st + 2;
    if (s.length > 256) return 2;
    return null;
  }

  // DCS: ESC P ... ST (ESC \)
  if (n1 === 'P') {
    const st = s.indexOf('\x1b\\');
    if (st > 0) return st + 2;
    // also allow BEL-terminated
    const bel = s.indexOf('\x07');
    if (bel > 0) return bel + 1;
    if (s.length > 256) return 2;
    return null;
  }

  // SS3 / two-byte
  if (n1 === 'O') {
    if (s.length < 3) return null;
    return 3;
  }

  // plain two-byte ESC X
  return 2;
}

function sanitizeSteer(raw) {
  let s = String(raw || '');
  // drop any residual protocol
  s = s
    .replace(/\x1b[\s\S]*?(?:[\x07\x9c]|\x1b\\)/g, '')
    .replace(/P>\|[^\n]*/g, '')
    .replace(/ghostty[^\n]*/gi, '')
    .replace(/[^\t\n\x20-\x7E\u00A0-\uFFFF]/g, '')
    .trim();
  if (!s) return '';
  if (s.length < 1) return '';
  // ignore pure noise
  if (/^[|\\/>P\s]+$/.test(s)) return '';
  return s.slice(0, 400);
}
