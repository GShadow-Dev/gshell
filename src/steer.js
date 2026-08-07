import process from 'node:process';

/**
 * While Gengar drives the PTY, local typing is NOT sent to the shell.
 * Characters buffer on a steer line; Enter delivers a STEER message.
 * Ctrl-C → callback (usually PTY ctrl-c); double Ctrl-C aborts.
 */
export class SteerInput {
  constructor({ onSteer, onInterrupt, onAbort }) {
    this.onSteer = onSteer;
    this.onInterrupt = onInterrupt;
    this.onAbort = onAbort;
    this.buf = '';
    this.lastSigint = 0;
    this._onData = (buf) => this._handle(buf);
  }

  start() {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this._onData);
    this._paint();
  }

  stop() {
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
    const s = buf.toString('binary');
    // Ctrl-C
    if (s === '\x03') {
      const now = Date.now();
      if (now - this.lastSigint < 700) {
        this.onAbort?.();
        return;
      }
      this.lastSigint = now;
      this.onInterrupt?.();
      return;
    }
    // Ctrl-D ignore / Ctrl-L clear buffer
    if (s === '\x04') return;
    if (s === '\x0c') {
      this.buf = '';
      this._paint();
      return;
    }
    // Enter → send steer
    if (s === '\r' || s === '\n') {
      const msg = this.buf.trim();
      this.buf = '';
      this._paint();
      if (msg) this.onSteer?.(msg);
      return;
    }
    // Backspace
    if (s === '\x7f' || s === '\b') {
      this.buf = this.buf.slice(0, -1);
      this._paint();
      return;
    }
    // Ignore other controls / paste escapes lightly
    if (s.startsWith('\x1b')) return;
    // Printable
    for (const ch of s) {
      if (ch >= ' ' && ch !== '\x7f') this.buf += ch;
    }
    // cap
    if (this.buf.length > 400) this.buf = this.buf.slice(0, 400);
    this._paint();
  }

  _paint() {
    if (!process.stderr.isTTY) return;
    const cols = process.stdout.columns || 80;
    const label = 'steer> ';
    const room = Math.max(8, cols - label.length - 1);
    const shown = this.buf.slice(-room);
    // bottom line via save/restore
    process.stderr.write(
      `\x1b7\x1b[${process.stdout.rows || 24};1H\x1b[38;2;255;180;84m${label}\x1b[38;2;244;241;235m${shown}\x1b[K\x1b[0m\x1b8`,
    );
  }

  _clearLine() {
    if (!process.stderr.isTTY) return;
    process.stderr.write(
      `\x1b7\x1b[${process.stdout.rows || 24};1H\x1b[K\x1b8`,
    );
  }
}
