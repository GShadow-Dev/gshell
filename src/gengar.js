import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SPRITE = [
  path.join(ROOT, 'assets', 'fire-gengar.png'),
  path.join(process.env.HOME || '', '.config/fish/assets/fire-gengar.png'),
].find((p) => fs.existsSync(p));

const HANDS = ['╱|╲', '╲|╱', '╱|╲', '╲|╱'];

const STATE_COLOR = {
  awake: '#ff7a18',
  thinking: '#c792ea',
  casting: '#ff7a18',
  watching: '#59d0d8',
  needs_you: '#ffb454',
  speaking: '#a78bfa',
  done: '#91c483',
  idle: '#5f6873',
};

/**
 * Gengar surface:
 * - Intro sprite once (before work) — allowed to use lines
 * - Live updates ONLY on the bottom status row (overwrite, no newlines)
 *   so brew logs never get dance garbage in scrollback.
 */
export class GengarOverlay {
  constructor() {
    this.state = 'awake';
    this.detail = '';
    this.frame = 0;
    this.timer = null;
    this.enabled = process.stdout.isTTY;
    this.spriteOnce = null;
    this._loadSprite();
  }

  _loadSprite() {
    if (!SPRITE) return;
    const r = spawnSync(
      'chafa',
      ['--format=symbols', '--size=8x4', '--animate=off', SPRITE],
      { encoding: 'utf8', maxBuffer: 100_000 },
    );
    if (r.status === 0 && r.stdout) this.spriteOnce = r.stdout.replace(/\s+$/, '');
  }

  /** Call once at session start — prints intro block above future scrollback. */
  intro(task) {
    if (!this.enabled) return;
    const line = '━'.repeat(40);
    const blocks = [];
    if (this.spriteOnce) {
      blocks.push(`\x1b[38;2;255;122;24m${this.spriteOnce}\x1b[0m`);
    } else {
      blocks.push('\x1b[38;2;255;122;24m󰈸 GENGAR\x1b[0m');
    }
    blocks.push(
      `\x1b[38;2;255;122;24m\x1b[1m󰈸 gSHELL // GEX\x1b[0m \x1b[38;2;95;104;115m//\x1b[0m \x1b[38;2;247;243;255mAUTOPILOT\x1b[0m`,
    );
    blocks.push(`\x1b[38;2;199;146;234m${task}\x1b[0m`);
    blocks.push(`\x1b[38;2;95;104;115m${line}\x1b[0m`);
    blocks.push(
      `\x1b[38;2;95;104;115mtype+enter steer · ctrl-c shell · ctrl-c×2 abort\x1b[0m`,
    );
    process.stderr.write(`${blocks.join('\n')}\n\n`);
  }

  start() {
    if (!this.enabled) return;
    this.setState('awake');
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % HANDS.length;
      this.paintBar();
    }, 320);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.setState('done', '');
    this.paintBar();
  }

  setState(state, detail = this.detail) {
    this.state = state;
    this.detail = detail || '';
    this.paintBar();
  }

  /** Bottom row only — overwrites itself, never inserts scroll lines. */
  paintBar() {
    if (!this.enabled || !process.stderr.isTTY) return;
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const color = STATE_COLOR[this.state] || STATE_COLOR.idle;
    const hands = HANDS[this.frame];
    const label = `󰈸 ${hands} gex · ${this.state}${this.detail ? ` · ${this.detail}` : ''}`;
    const clipped = label.length > cols - 1 ? label.slice(0, cols - 2) + '…' : label;
    const pad = ' '.repeat(Math.max(0, cols - clipped.length - 1));
    // Save cursor, move bottom, paint, restore — no newline
    process.stderr.write(
      `\x1b7\x1b[${rows};1H\x1b[48;2;8;9;12m\x1b[38;2;${hexToRgb(color)}m${clipped}${pad}\x1b[0m\x1b8`,
    );
  }

  /** Flash a one-line act notice above the bar without spamming scroll (stderr CR). */
  act(note) {
    this.setState('casting', note);
  }
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

export function flashBanner(task) {
  // Back-compat no-op intro without sprite — cli uses overlay.intro
  const line = '━'.repeat(40);
  process.stderr.write(
    `\x1b[38;2;255;122;24m\x1b[1m󰈸 gSHELL // GEX\x1b[0m \x1b[38;2;95;104;115m//\x1b[0m \x1b[38;2;247;243;255mAUTOPILOT\x1b[0m\n`,
  );
  process.stderr.write(`\x1b[38;2;199;146;234m${task}\x1b[0m\n`);
  process.stderr.write(`\x1b[38;2;95;104;115m${line}\x1b[0m\n\n`);
}

export function printHex(text, gengar) {
  gengar?.setState('speaking', 'hex');
  const bar = '━'.repeat(40);
  process.stdout.write(
    `\n\x1b[38;2;255;122;24m\x1b[1m━ HEX\x1b[0m \x1b[38;2;95;104;115m${bar}\x1b[0m\n\n`,
  );
  process.stdout.write(`${text}\n\n`);
  process.stdout.write(`\x1b[38;2;95;104;115m${'━'.repeat(52)}\x1b[0m\n`);
  gengar?.paintBar();
}
