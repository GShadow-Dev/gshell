import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SPRITE =
  [
    path.join(ROOT, 'assets', 'fire-gengar.png'),
    path.join(process.env.HOME || '', '.config/fish/assets/fire-gengar.png'),
  ].find((p) => fs.existsSync(p)) || path.join(ROOT, 'assets', 'fire-gengar.png');

// Hands up / down dance under the sprite rail
const DANCE = [
  ['  ╱|╲', '  ╱ ╲'],
  ['  ╲|╱', '  ╱ ╲'],
  ['  ╱|╲', '  ╲ ╱'],
  ['  ╲|╱', '  ╲ ╱'],
];

/**
 * Left-rail Gengar. Kitty image is placed once; dance lines animate under it.
 */
export class GengarOverlay {
  constructor() {
    this.frame = 0;
    this.timer = null;
    this.enabled = process.stdout.isTTY;
    this.spritePlaced = false;
    this.spriteBuf = null;
    this._loadSprite();
  }

  _loadSprite() {
    if (!fs.existsSync(SPRITE)) return;
    // Prefer symbols for a stable small rail; kitty image can fight scroll.
    // Use kitty only if chafa succeeds and TERM looks Ghostty-capable.
    const wantKitty =
      process.env.TERM_PROGRAM === 'ghostty' ||
      String(process.env.TERM || '').includes('ghostty') ||
      String(process.env.TERM || '').includes('kitty');

    if (wantKitty) {
      const r = spawnSync(
        'chafa',
        [
          '--format=kitty',
          '--size=10x5',
          '--align=top,left',
          '--animate=off',
          '--polite=on',
          SPRITE,
        ],
        { encoding: 'buffer', maxBuffer: 4_000_000 },
      );
      if (r.status === 0 && r.stdout?.length > 50) {
        this.spriteBuf = r.stdout;
        return;
      }
    }

    const r2 = spawnSync(
      'chafa',
      ['--format=symbols', '--size=10x5', '--animate=off', SPRITE],
      { encoding: 'utf8', maxBuffer: 200_000 },
    );
    if (r2.status === 0 && r2.stdout) {
      this.spriteBuf = Buffer.from(r2.stdout, 'utf8');
    }
  }

  start() {
    if (!this.enabled) return;
    this.paint(true);
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % DANCE.length;
      this.paint(false);
    }, 300);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  paint(placeSprite = false) {
    if (!this.enabled) return;
    const dance = DANCE[this.frame];
    const out = [];
    out.push(Buffer.from('\x1b7')); // save cursor

    if (placeSprite || !this.spritePlaced) {
      out.push(Buffer.from('\x1b[1;1H'));
      if (this.spriteBuf) out.push(this.spriteBuf);
      else out.push(Buffer.from('\x1b[38;2;255;122;24m󰈸 GENGAR\x1b[0m\n'));
      this.spritePlaced = true;
    }

    // Dance + label fixed rows under a 5-row sprite → rows 6–8
    const d1 = `\x1b[6;1H\x1b[38;2;199;146;234m${dance[0]}\x1b[K`;
    const d2 = `\x1b[7;1H\x1b[38;2;199;146;234m${dance[1]}\x1b[K`;
    const lab = `\x1b[8;1H\x1b[38;2;95;104;115m gex · autopilot\x1b[K\x1b[0m`;
    out.push(Buffer.from(d1 + d2 + lab, 'utf8'));
    out.push(Buffer.from('\x1b8')); // restore
    process.stdout.write(Buffer.concat(out));
  }
}

export function flashBanner(task) {
  const line = '━'.repeat(40);
  process.stderr.write(
    `\x1b[38;2;255;122;24m\x1b[1m󰈸 gSHELL // GEX\x1b[0m \x1b[38;2;95;104;115m//\x1b[0m \x1b[38;2;247;243;255mAUTOPILOT\x1b[0m\n`,
  );
  process.stderr.write(`\x1b[38;2;199;146;234m${task}\x1b[0m\n`);
  process.stderr.write(`\x1b[38;2;95;104;115m${line}\x1b[0m\n`);
  process.stderr.write(
    `\x1b[38;2;95;104;115mtype + enter to steer · ctrl-c → shell · ctrl-c twice → abort\x1b[0m\n\n`,
  );
}
