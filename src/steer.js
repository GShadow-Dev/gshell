import process from 'node:process';

/**
 * Local typing never goes to the driven PTY.
 * Type + Enter → STEER message (can say "stuck", "try X", "stop").
 * Ctrl-C once → interrupt driven shell
 * Ctrl-C twice fast → abort gex
 *
 * Paints on the second-to-last row so it stays visible under the gengar bar.
 */
export class SteerInput {
  constructor({ onSteer, onInterrupt, onAbort }) {
    this.onSteer = onSteer;
    this.onInterrupt = onInterrupt;
    this.onAbort = onAbort;
    this.buf = '';
    this.lastSigint = 0;
    this.active = false;
    this._onData = (buf) => this._handle(buf);
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
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', this._onData);
    // Keep steer line visible even when gengar repaints
    this._repaint = setInterval(() => this._paint(), 400);
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

  _handle(buf) {
    if (!this.active) return;
    const s = typeof buf === 'string' ? buf : buf.toString('utf8');

    // Ctrl-C
    if (s === '\u0003') {
      const now = Date.now();
      if (now - this.lastSigint < 900) {
        this.onAbort?.();
        return;
      }
      this.lastSigint = now;
      this.buf = '';
      this._paint();
      this.onInterrupt?.();
      return;
    }

    if (s === '\u0004') return; // ctrl-d
    if (s === '\u000c') {
      // ctrl-l clear steer buffer
      this.buf = '';
      this._paint();
      return;
    }

    // Enter
    if (s === '\r' || s === '\n') {
      const msg = this.buf.trim();
      this.buf = '';
      this._paint();
      if (msg) this.onSteer?.(msg);
      return;
    }

    // Backspace
    if (s === '\u007f' || s === '\b') {
      this.buf = this.buf.slice(0, -1);
      this._paint();
      return;
    }

    // ignore pure escapes (arrows etc.) but allow paste of text
    if (s.startsWith('\u001b') && s.length <= 6) return;

    for (const ch of s) {
      if (ch >= ' ' && ch !== '\u007f') this.buf += ch;
    }
    if (this.buf.length > 500) this.buf = this.buf.slice(0, 500);
    this._paint();
  }

  _paint() {
    if (!this.active || !process.stderr.isTTY) return;
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const label = 'steer› ';
    const room = Math.max(8, cols - label.length - 1);
    const shown = this.buf.slice(-room);
    const line = `${label}${shown}`;
    const pad = ' '.repeat(Math.max(0, cols - line.length - 1));
    // second-to-last row (gengar uses last row)
    const row = Math.max(1, rows - 1);
    process.stderr.write(
      `\x1b7\x1b[${row};1H\x1b[48;2;18;10;28m\x1b[38;2;255;180;84m${line}${pad}\x1b[0m\x1b8`,
    );
  }

  _clearLine() {
    if (!process.stderr.isTTY) return;
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const row = Math.max(1, rows - 1);
    process.stderr.write(
      `\x1b7\x1b[${row};1H\x1b[K${' '.repeat(Math.min(cols, 4))}\x1b[K\x1b8`,
    );
  }
}
