/**
 * Nested PTYs emit terminal queries (DA, OSC color, XTGETTCAP, kitty flags).
 * Those bytes are mirrored to stdout; Ghostty answers on *our* stdin — which
 * we stole for steering. So the child hangs and the user sees raw CSI garbage.
 *
 * Intercept queries in the PTY stream, answer into the PTY, strip from display.
 */

export class TermQueryFilter {
  constructor(writeToPty) {
    this.writeToPty = writeToPty;
    this.pending = '';
  }

  /**
   * @param {string} chunk
   * @returns {string} displayable bytes (queries removed)
   */
  push(chunk) {
    this.pending += chunk;
    let out = '';

    while (this.pending.length) {
      const esc = this.pending.indexOf('\x1b');
      if (esc === -1) {
        out += this.pending;
        this.pending = '';
        break;
      }
      // emit plain text before ESC
      out += this.pending.slice(0, esc);
      this.pending = this.pending.slice(esc);

      const handled = this._tryConsume();
      if (handled === null) {
        break;
      }
      if (handled === true) {
        continue;
      }
      if (handled === 'pass' && this._passthrough) {
        out += this._passthrough;
        this._passthrough = '';
        continue;
      }
      // false: not a query — pass one byte
      out += this.pending[0];
      this.pending = this.pending.slice(1);
    }
    return out;
  }

  /** @returns {true|false|null} true consumed, false not query, null need more */
  _tryConsume() {
    const s = this.pending;
    if (s.length < 2) return null;

    // OSC: ESC ] ... BEL or ST
    if (s.startsWith('\x1b]')) {
      const bel = s.indexOf('\x07');
      const st = s.indexOf('\x1b\\');
      let end = -1;
      let endLen = 0;
      if (bel !== -1 && (st === -1 || bel < st)) {
        end = bel;
        endLen = 1;
      } else if (st !== -1) {
        end = st;
        endLen = 2;
      }
      if (end === -1) return null;
      const body = s.slice(2, end);
      this.pending = s.slice(end + endLen);
      this._answerOsc(body);
      return true;
    }

    // DCS: ESC P ... ST  (XTGETTCAP etc.)
    if (s.startsWith('\x1bP')) {
      const st = s.indexOf('\x1b\\');
      if (st === -1) return null;
      const body = s.slice(2, st);
      this.pending = s.slice(st + 2);
      this._answerDcs(body);
      return true;
    }

    // CSI: ESC [ ... final byte @-~
    if (s.startsWith('\x1b[')) {
      const m = s.match(/^\x1b\[[0-9;?]*[ -/]*([@-~])/);
      if (!m) {
        // incomplete CSI
        if (s.length > 64) {
          // garbage — pass through
          return false;
        }
        return null;
      }
      const full = m[0];
      const final = m[1];
      this.pending = s.slice(full.length);
      if (this._answerCsi(full, final)) return true;
      this._passthrough = full;
      return 'pass';
    }

    // ESC + something else
    if (s.length < 2) return null;
    return false;
  }

  _answerCsi(full, final) {
    // Primary DA: ESC [ c  or ESC [ 0 c
    if (final === 'c' && /^\x1b\[[0-9;]*c$/.test(full) && !full.includes('>')) {
      // VT100-ish
      this.writeToPty('\x1b[?1;2c');
      return true;
    }
    // Secondary DA: ESC [ > c  or ESC [ > 0 c
    if (final === 'c' && full.includes('>')) {
      this.writeToPty('\x1b[>0;276;0c');
      return true;
    }
    // Cursor position report request: ESC [ 6 n
    if (final === 'n' && /6n$/.test(full)) {
      this.writeToPty('\x1b[1;1R');
      return true;
    }
    // Device status: ESC [ 5 n
    if (final === 'n' && /5n$/.test(full)) {
      this.writeToPty('\x1b[0n');
      return true;
    }
    // Kitty keyboard flags query: ESC [ ? u  (and push/pop variants)
    if (final === 'u' && full.includes('?')) {
      // Report no special flags
      this.writeToPty('\x1b[?0u');
      return true;
    }
    // DECRQM / mode queries — soft-ignore with empty-ish replies when obvious
    if (final === '$' || (final === 'p' && full.includes('$'))) {
      return true; // swallow
    }
    // XTVERSION sometimes as CSI
    return false;
  }

  _answerOsc(body) {
    // OSC 11 ; ?  → background color
    if (/^11;/.test(body) && body.includes('?')) {
      this.writeToPty('\x1b]11;rgb:0808/0909/0c0c\x07');
      return;
    }
    if (/^10;/.test(body) && body.includes('?')) {
      this.writeToPty('\x1b]10;rgb:e8e8/e6e6/e3e3\x07');
      return;
    }
    // Other OSC queries — swallow
    if (body.includes('?')) return;
  }

  _answerDcs(body) {
    // XTGETTCAP: +q <hex names>
    if (body.startsWith('+q')) {
      // Reply: DCS 0 + r ST (no matches) — safe default
      // Or DCS 1 + r ... for success. Ghostty shell integration probes indn etc.
      // Provide a minimal empty success to unblock.
      this.writeToPty('\x1bP0+r\x1b\\');
      return;
    }
    // XTVERSION
    if (body.startsWith('>|' ) || body.startsWith('$q') || body.startsWith('+p')) {
      this.writeToPty('\x1bP>|gex-autopilot 0.1\x1b\\');
      return;
    }
    // Swallow unknown DCS queries
  }
}
