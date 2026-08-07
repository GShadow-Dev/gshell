import { sleep } from './keys.js';
import { isLongJob, rewriteCommand } from './pilot/watch.js';
import { InteractiveAutopilot } from './pilot/interactive.js';
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

  // Reactive layer: answers y/n and mid-install cancel without LLM latency
  const auto = new InteractiveAutopilot(session, { gengar, track, task });
  auto.start();

  const messages = [
    { role: 'system', content: systemPrompt(task, memoryPack) },
    {
      role: 'user',
      content: `TASK:\n${task}\n\n--- MEMORY ---\n${memoryPack || '(empty room)'}\n--- SCREEN ---\n${session.screenText()}\n--- END ---`,
    },
  ];

  try {
    for (let step = 1; step <= maxSteps; step++) {
      drainSteers(steerQueue, messages, session, track, gengar);

      gengar?.setState('thinking', `${step}/${maxSteps}`);
      onStatus?.(`step ${step}/${maxSteps}`);

      const action = await callModel(apiKey, messages);
      messages.push({ role: 'assistant', content: JSON.stringify(action) });
      track('gex_act', {
        actor: 'gex',
        action: action.action,
        cmd: action.command || action.text || '',
      });

      const kind = action.action || 'done';

      if (kind === 'done' || kind === 'reply') {
        const msg = action.message || action.reason || 'Done.';
        track('gex_reply', { actor: 'gex', text: msg });
        gengar?.setState('speaking', 'hex');
        return { ok: true, message: msg, steps: step, sessionEvents, autoLog: auto.log };
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
        // Include auto log so mind knows y/ctrl-c already happened
        pushScreen(messages, session, `wait ${ms}ms auto=${fmtAuto(auto)}`);
        continue;
      }

      if (kind === 'key') {
        const keys = action.keys || (action.key ? [action.key] : []);
        // Skip redundant y if autopilot already answered
        if (
          auto.answeredConfirm &&
          keys.length === 1 &&
          /^(y|enter)$/i.test(keys[0])
        ) {
          pushScreen(messages, session, 'key skipped — autopilot already confirmed');
          continue;
        }
        gengar?.act(keys.join(' '));
        for (const k of keys) {
          await session.key(k);
          await sleep(35);
        }
        await session.waitFor({ quietMs: 300, timeoutMs: 15_000 });
        pushScreen(messages, session, `key ${keys.join(',')} auto=${fmtAuto(auto)}`);
        continue;
      }

      if (kind === 'type') {
        const text = String(action.text ?? '');
        if (auto.answeredConfirm && /^y(es)?$/i.test(text.trim())) {
          pushScreen(messages, session, 'type skipped — autopilot already confirmed');
          continue;
        }
        gengar?.act(clip(text, 24));
        await session.type(text, { delayMs: +action.delay_ms || 0 });
        await session.waitFor({ quietMs: 250, timeoutMs: 10_000 });
        pushScreen(messages, session, `type auto=${fmtAuto(auto)}`);
        continue;
      }

      if (kind === 'submit') {
        const line = rewriteCommand(action.command || action.text || '', task);
        // Reset per-command autopilot flags for confirm; keep cancelIntent
        auto.answeredConfirm = false;
        // cancel only once per task unless mind resets
        gengar?.act(clip(line, 40));
        track('cmd_start', { actor: 'gex', cmd: line });
        const t0 = Date.now();
        await session.submit(line);

        const useWatch = isLongJob(line) || action.watch || auto.cancelIntent;
        const result = await watchUntilDone(session, {
          gengar,
          steerQueue,
          auto,
          timeoutMs: +action.timeout_ms || (useWatch ? 600_000 : 180_000),
          quietMs: useWatch ? 1800 : (+action.quiet_ms || 500),
        });

        const out = session.screenText(14000);
        const ref = ledger?.putBlob(out, 'cmd');
        track('cmd_end', {
          actor: 'gex',
          cmd: line,
          exit: result.exitHint,
          duration_ms: Date.now() - t0,
          blob_ref: ref,
          tags: useWatch ? ['long_job'] : [],
          auto: fmtAuto(auto),
        });
        messages.push({
          role: 'user',
          content: `TOOL_RESULT submit reason=${result.reason} auto=${fmtAuto(auto)}\n$ ${line}\n--- SCREEN ---\n${out}\n--- END ---`,
        });

        // If task wanted cancel+cleanup and we cancelled, nudge mind to rm
        if (auto.cancelled && auto.cleanupIntent) {
          messages.push({
            role: 'user',
            content:
              'NOTE: Autopilot already sent ctrl-c mid-install. If leftover project dirs exist from this task, submit rm -rf on them, then done.',
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
      autoLog: auto.log,
    };
  } finally {
    auto.stop();
  }
}

async function watchUntilDone(session, { gengar, steerQueue, auto, timeoutMs, quietMs }) {
  gengar?.setState('watching', auto.cancelIntent ? 'watch+cancel' : 'long job');
  const start = Date.now();
  let lastBeat = 0;

  while (Date.now() - start < timeoutMs) {
    if (steerQueue?.length) return { reason: 'steer', exitHint: null };

    // Autopilot may have cancelled — wait for prompt after SIGINT
    const quiet = await session.waitFor({ quietMs, timeoutMs: quietMs + 800 });
    if (quiet.ok && quiet.reason === 'quiet') {
      const tail = session.screenText(500);
      if (isShellPrompt(tail) || session.exited) {
        return { reason: auto.cancelled ? 'cancelled' : 'prompt', exitHint: auto.cancelled ? 130 : 0 };
      }
      // quiet but not prompt — keep watching if long install without cancel done
      if (!auto.cancelIntent) {
        // still running silently?
        if (Date.now() - start > 5000 && isShellPrompt(tail)) {
          return { reason: 'prompt', exitHint: 0 };
        }
      }
    }

    if (Date.now() - lastBeat > 2000) {
      const tag = auto.cancelled ? 'cancelling' : auto.answeredConfirm ? 'running' : 'waiting';
      gengar?.setState('watching', `${tag} ${Math.round((Date.now() - start) / 1000)}s`);
      lastBeat = Date.now();
    }
    await sleep(80);
  }
  return { reason: 'timeout', exitHint: null };
}

function isShellPrompt(tail) {
  return /[❯╰─>$%#]\s*$/m.test(tail) || /gsh\/\d+/.test(tail) || /fish\s*$/m.test(tail);
}

function fmtAuto(auto) {
  return `y=${auto.answeredConfirm ? 1 : 0},cxl=${auto.cancelled ? 1 : 0}`;
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

You drive a LIVE fish shell. A FAST reactive layer already answers:
- "Ok to proceed? (y)" / [y/n] → sends y immediately (you will see it on SCREEN)
- If TASK asks to cancel mid-install → sends ctrl-c once install progress appears
Do NOT wait multi-step to press y. Prefer submit once, then observe auto=y=1,cxl=1 in TOOL_RESULT.

## JSON every turn (no fences)
{
  "action": "submit" | "type" | "key" | "wait" | "memory_search" | "done",
  "reason": "why",
  "message": "optional",
  "command": "full line for submit",
  "text": "type chars",
  "key": "enter",
  "keys": ["y"],
  "query": "for memory_search",
  "watch": true,
  "timeout_ms": 120000
}

## Actions
- submit: one command + Enter. Use full create-next-app flags. Host watches + auto y/cancel.
- type/key: only if reactive layer did not handle a prompt (password → done asking user).
- memory_search: dig room memory
- done: HEX result for the human

## Cancel+cleanup tasks
If TASK says cancel during install and delete files:
1. submit create-next-app (with flags) once
2. Host auto y + ctrl-c
3. On TOOL_RESULT with cxl=1, submit rm -rf <dir>
4. done

## Memory
MEMORY pack is incomplete by design. Use memory_search when needed.

## Safety
No sudo/rm -rf / / force-push/curl|sh unless demanded. Password → needs user.

Task: ${task}
`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
