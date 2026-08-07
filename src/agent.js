import { sleep } from './keys.js';
import { rewriteCommand, promptAfterMark, isShellPrompt } from './pilot/watch.js';
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

  const auto = new InteractiveAutopilot(session, {
    gengar,
    track,
    task,
    apiKey,
  });
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
        return {
          ok: true,
          message: msg,
          steps: step,
          sessionEvents,
          autoLog: auto.log,
        };
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
        pushScreen(messages, session, `wait ${ms}ms auto=${fmtAuto(auto)}`);
        continue;
      }

      if (kind === 'key') {
        const keys = action.keys || (action.key ? [action.key] : []);
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
        auto.answeredConfirm = false;
        gengar?.act(clip(line, 40));
        track('cmd_start', { actor: 'gex', cmd: line });
        const t0 = Date.now();

        // Mark buffer BEFORE submit so we never confuse old prompt with done
        const mark = session.buffer.length;
        await session.submit(line);

        // DYNAMIC: every submit watches until NEW prompt (or steer/timeout)
        const timeoutMs = +action.timeout_ms || 900_000; // 15 min default
        const result = await watchUntilPrompt(session, {
          mark,
          gengar,
          steerQueue,
          auto,
          timeoutMs,
        });

        const out = session.screenText(16000);
        const ref = ledger?.putBlob(out, 'cmd');
        track('cmd_end', {
          actor: 'gex',
          cmd: line,
          exit: result.exitHint,
          duration_ms: Date.now() - t0,
          blob_ref: ref,
          tags: ['watched'],
          auto: fmtAuto(auto),
        });
        messages.push({
          role: 'user',
          content: `TOOL_RESULT submit reason=${result.reason} elapsed_ms=${Date.now() - t0} auto=${fmtAuto(auto)}\n$ ${line}\n--- SCREEN ---\n${out}\n--- END ---`,
        });

        if (auto.cancelled && auto.cleanupIntent) {
          messages.push({
            role: 'user',
            content:
              'NOTE: Autopilot sent ctrl-c mid-install. If leftover dirs exist from this task, submit rm -rf on them, then done.',
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

/**
 * Wait until the shell shows a prompt that appears AFTER mark.
 * Heartbeat on the Gengar bar so long quiet jobs never look frozen.
 */
async function watchUntilPrompt(
  session,
  { mark, gengar, steerQueue, auto, timeoutMs },
) {
  gengar?.setState('watching', 'run');
  const start = Date.now();
  let lastLen = session.buffer.length;
  let lastGrowth = Date.now();
  let lastBeat = 0;
  let lastTickLine = 0;
  let peakLen = lastLen;

  while (Date.now() - start < timeoutMs) {
    if (steerQueue?.length) return { reason: 'steer', exitHint: null };
    if (session.exited) return { reason: 'exited', exitHint: session.exitCode };

    const len = session.buffer.length;
    if (len !== lastLen) {
      lastLen = len;
      lastGrowth = Date.now();
      if (len > peakLen) peakLen = len;
    }

    if (promptAfterMark(session, mark)) {
      const quietFor = Date.now() - lastGrowth;
      if (quietFor >= 450) {
        return {
          reason: auto.cancelled ? 'cancelled' : 'prompt',
          exitHint: auto.cancelled ? 130 : 0,
        };
      }
    }

    const now = Date.now();
    if (now - lastBeat > 900) {
      const s = Math.round((now - start) / 1000);
      const silent = Math.round((now - lastGrowth) / 1000);
      const flowing = now - lastGrowth < 1500;
      const snap = lastOutputHint(session, mark);
      const tag = auto.cancelled
        ? 'cancelling'
        : flowing
          ? 'live'
          : silent >= 8
            ? `silent ${silent}s`
            : 'waiting';
      // Compact: live 42s · hosts up · silent 3s
      const detail = snap
        ? `${tag} ${s}s · ${snap}`
        : `${tag} ${s}s`;
      gengar?.setState('watching', clip(detail, 48));
      lastBeat = now;
    }

    // Every 15s of silence, pulse a stronger cast flash so human knows we're alive
    if (now - lastGrowth >= 15000 && now - lastTickLine >= 15000) {
      gengar?.act(`still watching ${Math.round((now - start) / 1000)}s`);
      lastTickLine = now;
    }

    await sleep(100);
  }
  return { reason: 'timeout', exitHint: null };
}

/** Pull a short human hint from newest output after mark. */
function lastOutputHint(session, mark) {
  const delta = session.buffer.slice(mark);
  const text = String(delta)
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^╰─/.test(l) && !/^gsh\//.test(l));
  if (!lines.length) return '';
  let last = lines[lines.length - 1];
  // Prefer progress-ish lines if present in last few
  for (const l of lines.slice(-6).reverse()) {
    if (/(stats:|%|etc:|done|up |latency|report for|scanning|elapsed|hosts?)/i.test(l)) {
      last = l;
      break;
    }
  }
  // compress noise
  last = last.replace(/\s+/g, ' ');
  if (last.length > 36) last = `${last.slice(0, 34)}…`;
  return last;
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

function systemPrompt(task) {
  return `You are Gengar — terminal AUTOPILOT (gex) in Ghostty.

You drive a LIVE fish shell. After every submit, the host DYNAMICALLY waits until
the shell prompt returns (minutes-long nmap/brew/npm are fine). You do NOT need
to poll. You get one TOOL_RESULT when the command finishes.

Interactive prompts (y/n, menus, Type DELETE) are answered by a separate FAST
AI micro-decision on the byte stream — not hard-coded. You may see y/n appear
on SCREEN without spending a main-loop step.

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
  "timeout_ms": 900000
}

## Rules
- Prefer few submits that finish; don't spam short waits for long scans.
- nmap -O needs root — use -sV without sudo unless user asked for root.
- After fingerprint/scan TOOL_RESULT, action=done with a clear summary.
- Cancel+cleanup tasks: submit install once; host may ctrl-c; then rm -rf; done.
- Password → done asking user (never invent secrets).
- memory_search digs room history.

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

// silence unused import if tree-shaken
void isShellPrompt;
void clamp;
