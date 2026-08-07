import { sleep } from './keys.js';
import { isLongJob, detectPrompt, rewriteCommand } from './pilot/watch.js';
import { searchBlobs } from './memory/retrieve.js';

const API = 'https://api.deepseek.com/chat/completions';

export async function runAgent({
  session,
  task,
  apiKey,
  maxSteps = 28,
  steerQueue,
  onStatus,
  gengar,
  ledger,
  memoryPack = '',
}) {
  const sessionEvents = [];
  const track = (kind, fields) => {
    const ev = ledger?.append(kind, fields);
    if (ev) sessionEvents.push(ev);
    return ev;
  };

  track('session_start', { actor: 'gex', task, cwd: process.cwd() });

  const messages = [
    { role: 'system', content: systemPrompt(task, memoryPack) },
    {
      role: 'user',
      content: `TASK:\n${task}\n\n--- MEMORY ---\n${memoryPack || '(empty room)'}\n--- SCREEN ---\n${session.screenText()}\n--- END ---`,
    },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    drainSteers(steerQueue, messages, session, track, gengar);

    gengar?.setState('thinking', `${step}/${maxSteps}`);
    onStatus?.(`step ${step}/${maxSteps}`);

    const action = await callModel(apiKey, messages);
    messages.push({ role: 'assistant', content: JSON.stringify(action) });
    track('gex_act', { actor: 'gex', action: action.action, cmd: action.command || action.text || '' });

    const kind = action.action || 'done';

    if (kind === 'done' || kind === 'reply') {
      const msg = action.message || action.reason || 'Done.';
      track('gex_reply', { actor: 'gex', text: msg });
      gengar?.setState('speaking', 'hex');
      return { ok: true, message: msg, steps: step, sessionEvents };
    }

    if (kind === 'memory_search') {
      const q = action.query || action.text || task;
      gengar?.setState('thinking', 'recall');
      const hits = searchBlobs(ledger, q, 4);
      const blobBits = hits
        .map((h) => `ref=${h.ref}\n${h.lines.join('\n')}`)
        .join('\n---\n');
      messages.push({
        role: 'user',
        content: `MEMORY_RESULT q=${q}\n${blobBits || '(no blob hits)'}\n--- SCREEN ---\n${session.screenText()}`,
      });
      continue;
    }

    if (kind === 'wait') {
      const ms = clamp(+action.ms || 700, 100, 20_000);
      gengar?.setState('watching', `${ms}ms`);
      await session.waitFor({ quietMs: ms, timeoutMs: ms + 400 });
      pushScreen(messages, session, `wait ${ms}ms`);
      continue;
    }

    if (kind === 'key') {
      const keys = action.keys || (action.key ? [action.key] : []);
      gengar?.act(keys.join(' '));
      for (const k of keys) {
        await session.key(k);
        await sleep(35);
      }
      // Confirm keys are first-class for sprite
      if (keys.some((k) => /^(y|n|enter)$/i.test(k)) || keys.includes('y') || action.text === 'y') {
        track('confirm', { actor: 'gex', text: keys.join(' ') });
      }
      await session.waitFor({ quietMs: 300, timeoutMs: 15_000 });
      // Auto-handle if still on confirm? let next loop see screen
      pushScreen(messages, session, `key ${keys.join(',')}`);
      continue;
    }

    if (kind === 'type') {
      const text = String(action.text ?? '');
      gengar?.act(clip(text, 24));
      await session.type(text, { delayMs: +action.delay_ms || 0 });
      if (/^y(es)?$/i.test(text.trim()) || /^n(o)?$/i.test(text.trim())) {
        track('confirm', { actor: 'gex', text: text.trim() });
      }
      await session.waitFor({ quietMs: 250, timeoutMs: 10_000 });
      pushScreen(messages, session, 'type');
      continue;
    }

    if (kind === 'submit') {
      let line = rewriteCommand(action.command || action.text || '', task);
      gengar?.act(clip(line, 40));
      track('cmd_start', { actor: 'gex', cmd: line });
      const t0 = Date.now();
      await session.submit(line);

      if (isLongJob(line) || action.watch) {
        // Watch mode: don't burn LLM turns; wait for settle / confirm / exit
        const result = await watchJob(session, {
          gengar,
          steerQueue,
          track,
          timeoutMs: +action.timeout_ms || 600_000,
        });
        const out = session.screenText(14000);
        const ref = ledger?.putBlob(out, 'cmd');
        track('cmd_end', {
          actor: 'gex',
          cmd: line,
          exit: result.exitHint,
          duration_ms: Date.now() - t0,
          blob_ref: ref,
          tags: ['long_job'],
        });
        messages.push({
          role: 'user',
          content: `TOOL_RESULT submit+watch reason=${result.reason}\n$ ${line}\n--- SCREEN ---\n${out}\n--- END ---`,
        });
      } else {
        const w = await session.waitFor({
          quietMs: +action.quiet_ms || 550,
          timeoutMs: +action.timeout_ms || 180_000,
        });
        // Auto-confirm green y/n if brew-style prompt appears mid-command
        const prompt = detectPrompt(session.screenText());
        if (prompt?.type === 'confirm_yn' && prompt.tier === 'green') {
          gengar?.act('y');
          track('confirm', { actor: 'gex', text: 'y', auto: true });
          await session.type('y');
          await session.key('enter');
          await session.waitFor({ quietMs: 800, timeoutMs: 600_000 });
        }
        const out = session.screenText(12000);
        const ref = ledger?.putBlob(out, 'cmd');
        track('cmd_end', {
          actor: 'gex',
          cmd: line,
          duration_ms: Date.now() - t0,
          blob_ref: ref,
        });
        messages.push({
          role: 'user',
          content: `TOOL_RESULT submit wait=${w.reason}\n$ ${line}\n--- SCREEN ---\n${out}\n--- END ---`,
        });
      }
      continue;
    }

    pushScreen(messages, session, `unknown action ${kind}`);
  }

  return {
    ok: false,
    message: 'Step limit reached.',
    steps: maxSteps,
    sessionEvents,
  };
}

async function watchJob(session, { gengar, steerQueue, track, timeoutMs }) {
  gengar?.setState('watching', 'long job');
  const start = Date.now();
  let lastSteer = 0;

  while (Date.now() - start < timeoutMs) {
    // User steer aborts watch early for mind
    if (steerQueue?.length) {
      return { reason: 'steer', exitHint: null };
    }
    const screen = session.screenText();
    const prompt = detectPrompt(screen);
    if (prompt?.type === 'password') {
      gengar?.setState('needs_you', 'password');
      track('caveat', { text: 'password prompt — needs user' });
      return { reason: 'password', exitHint: null };
    }
    if (prompt?.type === 'confirm_yn') {
      gengar?.act('y');
      track('confirm', { actor: 'gex', text: 'y', auto: true });
      await session.type('y');
      await session.key('enter');
      await sleep(400);
      gengar?.setState('watching', 'long job');
      continue;
    }
    // Quiet prompt-ish end: two quiet seconds after output
    const quiet = await session.waitFor({ quietMs: 2000, timeoutMs: 2500 });
    if (quiet.ok && quiet.reason === 'quiet') {
      // Heuristic: look like shell prompt returned
      const tail = session.screenText(400);
      if (/[❯❯╰─>$%#]\s*$/m.test(tail) || /gsh\/\d+/.test(tail)) {
        return { reason: 'prompt', exitHint: 0 };
      }
    }
    // heartbeat sprite
    if (Date.now() - lastSteer > 3000) {
      gengar?.setState('watching', `t=${Math.round((Date.now() - start) / 1000)}s`);
      lastSteer = Date.now();
    }
    await sleep(200);
  }
  return { reason: 'timeout', exitHint: null };
}

function drainSteers(q, messages, session, track, gengar) {
  if (!q?.length) return;
  const lines = q.splice(0, q.length);
  gengar?.setState('awake', 'steer');
  for (const text of lines) track('steer', { actor: 'user', text });
  messages.push({
    role: 'user',
    content: `STEER from user (obey immediately):\n${lines.join('\n')}\n\n--- SCREEN ---\n${session.screenText()}\n--- END ---`,
  });
}

function pushScreen(messages, session, note) {
  messages.push({
    role: 'user',
    content: `TOOL_RESULT ${note}\n--- SCREEN ---\n${session.screenText()}\n--- END ---`,
  });
}

async function callModel(apiKey, messages) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      temperature: 0.1,
      stream: false,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall */
      }
    }
    return { action: 'done', message: content || 'No action' };
  }
}

function systemPrompt(task, memoryPack) {
  return `You are Gengar — terminal AUTOPILOT (gex) in Ghostty.

You drive a LIVE fish shell. Human watches real TTY. Sprite is bottom status (not scrollback).
Human typing steers you (Enter). You pick settings. No handoff. No wizards when you can pass flags.

## JSON every turn (no fences)
{
  "action": "submit" | "type" | "key" | "wait" | "memory_search" | "done",
  "reason": "why",
  "message": "optional",
  "command": "full line for submit",
  "text": "type chars",
  "key": "enter",
  "keys": ["y"] ,
  "query": "for memory_search",
  "watch": true,
  "ms": 800,
  "quiet_ms": 600,
  "timeout_ms": 120000
}

## Actions
- submit: type command + Enter. Set watch=true for brew/npm/cargo/docker long jobs.
- type / key: drive prompts. For [y/n] prefer type "y" or keys. Host may auto-y green confirms.
- wait: short settle
- memory_search: pull searchable room memory (use when task refers to past work)
- done: finish — message is the HEX result the human reads

## Memory
You receive a MEMORY pack at start (summaries, recent cmds, hits). It is incomplete by design.
Use memory_search to dig. Do not assume absence of evidence is evidence of absence without search.

## Pilot rules
1. Read SCREEN. Drive interactive UI with keys.
2. Prefer fully flagged noninteractive launches (create-next-app --ts --tailwind ...).
3. Long installers: one submit with watch=true, then done from SCREEN.
4. STEER overrides plan immediately.
5. Info tasks: submit real command, done with findings (not "run this yourself").
6. One atomic action per turn.

## Safety
No sudo/rm -rf //force push/curl|sh unless user demanded. Password → done asking user to run manually.

Task: ${task}
`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
