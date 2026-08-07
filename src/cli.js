import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PtySession, defaultShell } from './pty_session.js';
import { runAgent } from './agent.js';
import { GengarOverlay, printHex } from './gengar.js';
import { SteerInput } from './steer.js';
import { sleep } from './keys.js';
import { resolveRoomId, gexHome } from './memory/room.js';
import { Ledger } from './memory/ledger.js';
import { buildSummonPack } from './memory/retrieve.js';
import { distillSession } from './memory/distill.js';

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
  gengar.setState('thinking', 'survey+efficiency');

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

  const onProgressHex = (note) => {
    printHex(note, gengar);
    process.stderr.write(`\x1b[38;2;95;104;115m(progress — still working)\x1b[0m\n`);
  };

  let result = { ok: false, message: 'aborted', sessionEvents: [] };
  try {
    const agentPromise = runAgent({
      session,
      task,
      apiKey,
      maxSteps: opts.maxSteps,
      steerQueue,
      onStatus: (s) =>
        gengar.setState(gengar.state === 'watching' ? 'watching' : 'thinking', s),
      gengar,
      ledger,
      memoryPack,
      onProgressHex,
    });

    while (!aborted) {
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
      result = { ok: false, message: 'Aborted by user.', sessionEvents: [] };
      ledger.append('session_abort', { actor: 'user' });
    }
  } finally {
    steer.stop();
  }

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

  const events = ledger.tail(200).filter((e) => e.session === ledger.sessionId);
  const summary = distillSession({
    task,
    events,
    finalMessage: result.message,
  });
  if (result.efficiency) summary.efficiency = result.efficiency;
  if (result.commands) summary.commands = result.commands;
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
          efficiency: result.efficiency || null,
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
  const opts = { _: [], help: false, maxSteps: 32 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--max-steps') opts.maxSteps = Number(argv[++i]) || 32;
    else if (a === 'recall' || a === 'log') opts._.push(a);
    else if (a.startsWith('-')) {
      process.stderr.write(`gex: unknown flag ${a}\n`);
      process.exit(2);
    } else opts._.push(a);
  }
  if (opts._[0] === 'recall') {
    const roomId = resolveRoomId(process.env);
    const ledger = new Ledger(roomId);
    console.log(buildSummonPack(ledger, opts._.slice(1).join(' ') || 'recent'));
    process.exit(0);
  }
  return opts;
}

function printHelp() {
  console.log(
    `
gex — terminal autopilot (best tool for the job)

  Surveys PATH/project, forces an efficiency plan, can install better tools
  (e.g. tree for directory maps), run parallel jobs, progressive HEX,
  remembers winning recipes.

Usage:
  gex <any task>
  gex print this directory as a tree
  gex recall <query>

Steer: type+enter · stop · ctrl-c · ctrl-c×2 abort
toolkit: ~/.cache/gex/toolkit/
`.trim(),
  );
}
