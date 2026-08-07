import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PtySession, defaultShell } from './pty_session.js';
import { runAgent } from './agent.js';
import { GengarOverlay, printHex } from './gengar.js';
import { SteerInput } from './steer.js';
import { sleep } from './keys.js';
import { resolveRoomId } from './memory/room.js';
import { Ledger } from './memory/ledger.js';
import { buildSummonPack } from './memory/retrieve.js';
import { distillSession } from './memory/distill.js';
import { gexHome } from './memory/room.js';

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
  const roomId = resolveRoomId(process.env);
  const ledger = new Ledger(roomId);
  const memoryPack = buildSummonPack(ledger, task);

  const gengar = new GengarOverlay();
  gengar.intro(task);
  gengar.start();
  gengar.setState('awake', roomId.slice(0, 8));

  const session = new PtySession({
    shell: defaultShell(),
    cwd: process.cwd(),
  }).start();

  await session.waitFor({ quietMs: 600, timeoutMs: 12_000 });
  if (session.screenText().trim().length < 5) {
    await session.key('enter');
    await session.waitFor({ quietMs: 400, timeoutMs: 5_000 });
  }
  gengar.setState('thinking', 'plan');

  const steerQueue = [];
  let aborted = false;

  const steer = new SteerInput({
    onSteer: (msg) => {
      if (/^(stop|abort|quit|exit)$/i.test(msg)) {
        aborted = true;
        return;
      }
      steerQueue.push(msg);
      gengar.setState('awake', 'steer');
      process.stderr.write(`\n\x1b[38;2;255;180;84m→ steered:\x1b[0m ${msg}\n`);
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
    // status goes to gengar bar only — no extra scroll
    gengar.setState(gengar.state === 'watching' ? 'watching' : 'thinking', s);
  };

  let result = { ok: false, message: 'aborted', sessionEvents: [] };
  try {
    const agentPromise = runAgent({
      session,
      task,
      apiKey,
      maxSteps: opts.maxSteps,
      steerQueue,
      onStatus,
      gengar,
      ledger,
      memoryPack,
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
      result = { ok: false, message: 'Aborted by user.', sessionEvents: result.sessionEvents || [] };
      ledger.append('session_abort', { actor: 'user' });
    }
  } finally {
    steer.stop();
  }

  // Flush driven shell
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

  // Distill + persist
  const events = ledger.tail(200).filter((e) => e.session === ledger.sessionId);
  const summary = distillSession({
    task,
    events,
    finalMessage: result.message,
  });
  ledger.writeSummary(summary);
  ledger.append('session_end', {
    actor: 'gex',
    ok: !!result.ok,
    text: result.message,
  });

  printHex(result.message || 'Session ended.', gengar);
  gengar.stop();

  try {
    fs.mkdirSync(gexHome(), { recursive: true });
    fs.writeFileSync(
      path.join(gexHome(), 'last-exit.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          roomId,
          sessionId: ledger.sessionId,
          task,
          ok: !!result.ok,
          message: result.message || '',
          cwd: process.cwd(),
          summary,
        },
        null,
        2,
      ),
    );
  } catch {
    /* ignore */
  }

  process.exit(result.ok ? 0 : 2);
}

function parseArgs(argv) {
  const opts = { _: [], help: false, maxSteps: 28 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--max-steps') opts.maxSteps = Number(argv[++i]) || 28;
    else if (a === 'recall' || a === 'log') {
      // handled lightly
      opts.help = false;
      opts._.push(a);
    } else if (a.startsWith('-')) {
      process.stderr.write(`gex: unknown flag ${a}\n`);
      process.exit(2);
    } else opts._.push(a);
  }
  // gex recall <q>
  if (opts._[0] === 'recall') {
    const roomId = resolveRoomId(process.env);
    const ledger = new Ledger(roomId);
    const q = opts._.slice(1).join(' ') || '';
    const pack = buildSummonPack(ledger, q || 'recent');
    console.log(pack);
    process.exit(0);
  }
  return opts;
}

function printHelp() {
  console.log(`
gex — Ghostty terminal autopilot (Gengar)

  Native TTY. Bottom status sprite (no scroll poison).
  Drives live fish. Enter steers. Remembers the room.

Usage:
  gex <task>
  gex show me system stats
  gex please update homebrew apps
  gex recall brew          # memory pack dump

Steer: type+enter · stop/abort · ctrl-c shell · ctrl-c×2 abort
Env: DEEPSEEK_API_KEY
Memory: ~/.cache/gex/rooms/<room>/
`.trim());
}
