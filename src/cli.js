import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PtySession, defaultShell } from './pty_session.js';
import { runAgent } from './agent.js';
import { GengarOverlay, flashBanner } from './gengar.js';
import { SteerInput } from './steer.js';
import { sleep } from './keys.js';

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || opts._.length === 0) {
    printHelp();
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    process.stderr.write('gex: DEEPSEEK_API_KEY is not set\n');
    process.exit(2);
  }

  const task = opts._.join(' ');
  await flashBanner(task);

  const gengar = new GengarOverlay();
  gengar.start();

  const session = new PtySession({
    shell: defaultShell(),
    cwd: process.cwd(),
  }).start();

  // Let fish draw (greeting may paint under gengar; gengar keeps dancing on top)
  await session.waitFor({ quietMs: 800, timeoutMs: 10_000 });
  gengar.paint();

  const steerQueue = [];
  let aborted = false;

  const steer = new SteerInput({
    onSteer: (msg) => {
      if (/^(stop|abort|quit|exit)$/i.test(msg)) {
        aborted = true;
        return;
      }
      steerQueue.push(msg);
      process.stderr.write(
        `\n\x1b[38;2;255;180;84m→ steered:\x1b[0m ${msg}\n`,
      );
    },
    onInterrupt: () => {
      process.stderr.write('\n\x1b[33mctrl-c → shell (again to abort gex)\x1b[0m\n');
      try {
        session.key('ctrl-c');
      } catch {
        /* ignore */
      }
    },
    onAbort: () => {
      aborted = true;
      process.stderr.write('\n\x1b[33mgex: abort\x1b[0m\n');
    },
  });
  steer.start();

  const onStatus = (s) => {
    // subtle status near bottom-right without stealing the steer line
    if (!process.stderr.isTTY) return;
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const text = ` gex · ${s} `;
    const col = Math.max(1, cols - text.length);
    process.stderr.write(
      `\x1b7\x1b[${rows - 1};${col}H\x1b[38;2;95;104;115m${text}\x1b[0m\x1b8`,
    );
  };

  let result = { ok: false, message: 'aborted' };
  try {
    // Parallel abort watcher
    const agentPromise = runAgent({
      session,
      task,
      apiKey,
      maxSteps: opts.maxSteps,
      steerQueue,
      onStatus,
    });

    while (true) {
      if (aborted) break;
      const done = await Promise.race([
        agentPromise.then((r) => ({ type: 'done', r })),
        sleep(100).then(() => ({ type: 'tick' })),
      ]);
      if (done.type === 'done') {
        result = done.r;
        break;
      }
    }
    if (aborted) {
      try {
        await session.key('ctrl-c');
      } catch {
        /* ignore */
      }
      result = { ok: false, message: 'Aborted by user.' };
    }
  } finally {
    steer.stop();
    gengar.stop();
  }

  // Flush history in driven shell, then exit it
  try {
    if (!session.exited) {
      await session.submit('history save 2>/dev/null');
      await sleep(150);
      await session.type('exit\r');
      await sleep(250);
    }
  } catch {
    /* ignore */
  }
  await session.dispose();

  // Parent fish can history merge
  try {
    const dir = path.join(process.env.HOME || '', '.cache/gex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'last-exit.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          task,
          ok: !!result.ok,
          message: result.message || '',
          cwd: process.cwd(),
        },
        null,
        2,
      ),
    );
  } catch {
    /* ignore */
  }

  process.stdout.write('\n');
  process.stdout.write(
    `\x1b[38;2;255;122;24m\x1b[1m━ HEX\x1b[0m \x1b[38;2;95;104;115m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n\n`,
  );
  process.stdout.write(`${result.message || ''}\n\n`);
  process.stdout.write(
    `\x1b[38;2;95;104;115m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n`,
  );

  // Hint parent shell
  process.stdout.write(
    `\x1b[38;2;95;104;115m↑ history: run \x1b[0m\x1b[38;2;89;208;216mhistory merge\x1b[0m\x1b[38;2;95;104;115m if needed\x1b[0m\n`,
  );

  process.exit(result.ok ? 0 : 2);
}

function parseArgs(argv) {
  const opts = { _: [], help: false, maxSteps: 28 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--max-steps') opts.maxSteps = Number(argv[++i]) || 28;
    else if (a.startsWith('-')) {
      process.stderr.write(`gex: unknown flag ${a}\n`);
      process.exit(2);
    } else opts._.push(a);
  }
  return opts;
}

function printHelp() {
  console.log(`
gex — Ghostty terminal autopilot (Gengar drives your shell)

  Native terminal only. Dancing fire-Gengar on the left.
  Gengar types into a live fish PTY (tab, arrows, ctrl-*, wizards).
  Your keystrokes steer him — Enter sends a message. Not a second UI.

Usage:
  gex <task>
  gex show me system stats
  gex scaffold a nextjs app called dashboard
  gex find the biggest file with fzf and open it

Steer:
  type + Enter     message Gengar mid-flight
  stop|abort       end (as a steer message)
  Ctrl-C           send ctrl-c to the driven shell
  Ctrl-C twice     abort gex

Env:
  DEEPSEEK_API_KEY
`.trim());
}
