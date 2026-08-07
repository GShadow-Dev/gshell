import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './keys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SPRITE = path.join(ROOT, 'assets', 'fire-gengar.png');

// Dance frames: hands / body bob (unicode, sits under sprite)
const DANCE = [
  ['  ╱|╲', '  ╱ ╲'],
  ['  ╲|╱', '  ╱ ╲'],
  ['  ╱|╲', '  ╲ ╱'],
  ['  ╲|╱', '  ╲ ╱'],
];

/**
 * Left-rail Gengar that re-paints without owning the whole screen.
 * Uses kitty image placement when chafa is available (Ghostty).
 */
export class GengarOverlay {
  constructor() {
    this.frame = 0;
    this.timer = null;
    this.kittyPayload = null;
    this.enabled = process.stdout.isTTY;
    this._loadSprite();
  }

  _loadSprite() {
    if (!fs.existsSync(SPRITE)) return;
    const chafa = spawnSync(
      'chafa',
      ['--format=kitty', '--size=12x6', '--animate=off', '--polite=on', SPRITE],
      { encoding: 'buffer', maxBuffer: 2_000_000 },
    );
    if (chafa.status === 0 && chafa.stdout?.length) {
      this.kittyPayload = chafa.stdout;
    }
  }

  start() {
    if (!this.enabled) return;
    this.paint();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % DANCE.length;
      this.paint();
    }, 280);
    // don't keep process alive alone
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.clear();
  }
  /** Save cursor, draw at 1,1, restore — shell output continues underneath. */
  paint() {
    if (!this.enabled) return;
    const dance = DANCE[this.frame];
    const parts = [];
    parts.push('\x1b7'); // save cursor (DECSC)
    parts.push('\x1b[1;1H'); // home
    // dim chrome
    parts.push('\x1b[38;2;255;122;24m');
    if (this.kittyPayload) {
      // Move to origin; chafa kitty stream includes newlines for cells
      parts.push(this.kittyPayload.toString('binary'));
    } else {
      parts.push('󰈸 GENGAR\n');
    }
    // Dance lines in ember/lavender under/ beside
    parts.push('\x1b[38;2;199;146;234m');
    parts.push(`\x1b[7;1H${dance[0]}\x1b[K`);
    parts.push(`\x1b[8;1H${dance[1]}\x1b[K`);
    parts.push('\x1b[38;2;95;104;115m');
    parts.push('\x1b[9;1H gex · autopilot\x1b[K');
    parts.push('\x1b[0m');
    parts.push('\x1b8'); // restore cursor
    // binary-safe write for kitty
    process.stdout.write(Buffer.from(parts.join(''), 'binary'));
  }

  clear() {
    if (!this.enabled) return;
    process.stdout.write(
      '\x1b7\x1b[1;1H\x1b[9;1H\x1b[1J\x1b8', // clear from home roughly
    );
  }
}

export async function flashBanner(task) {
  const line = '━'.repeat(40);
  process.stderr.write(
    `\x1b[38;2;255;122;24m\x1b[1m󰈸 gSHELL // GEX\x1b[0m \x1b[38;2;95;104;115m//\x1b[0m \x1b[38;2;247;243;255mAUTOPILOT\x1b[0m\n`,
  );
  process.stderr.write(`\x1b[38;2;199;146;234m${task}\x1b[0m\n`);
  process.stderr.write(`\x1b[38;2;95;104;115m${line}\x1b[0m\n`);
  process.stderr.write(
    `\x1b[38;2;95;104;115mtype + enter to steer · ctrl-c → shell · ctrl-c twice → abort\x1b[0m\n\n`,
  );
  await sleep(30);
}
