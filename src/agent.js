import { sleep } from './keys.js';

const API = 'https://api.deepseek.com/chat/completions';

export async function runAgent({
  session,
  task,
  apiKey,
  maxSteps = 28,
  steerQueue,
  onStatus,
}) {
  const messages = [
    { role: 'system', content: systemPrompt(task) },
    {
      role: 'user',
      content: `TASK:\n${task}\n\n--- SCREEN ---\n${session.screenText()}\n--- END ---`,
    },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    drainSteers(steerQueue, messages, session);

    onStatus?.(`step ${step}/${maxSteps}`);
    const action = await callModel(apiKey, messages);
    messages.push({ role: 'assistant', content: JSON.stringify(action) });

    const kind = action.action || 'done';

    if (kind === 'done' || kind === 'reply') {
      return { ok: true, message: action.message || action.reason || 'Done.', steps: step };
    }

    if (kind === 'wait') {
      const ms = clamp(+action.ms || 700, 100, 20_000);
      await session.waitFor({ quietMs: ms, timeoutMs: ms + 400 });
      pushScreen(messages, session, `wait ${ms}ms`);
      continue;
    }

    if (kind === 'key') {
      const keys = action.keys || (action.key ? [action.key] : []);
      try {
        for (const k of keys) {
          await session.key(k);
          await sleep(35);
        }
        await session.waitFor({ quietMs: 300, timeoutMs: 15_000 });
        pushScreen(messages, session, `key ${keys.join(',')}`);
      } catch (e) {
        pushScreen(messages, session, `key error ${e.message}`);
      }
      continue;
    }

    if (kind === 'type') {
      await session.type(String(action.text ?? ''), {
        delayMs: +action.delay_ms || 0,
      });
      await session.waitFor({ quietMs: 250, timeoutMs: 10_000 });
      pushScreen(messages, session, 'type');
      continue;
    }

    if (kind === 'submit') {
      const line = action.command || action.text || '';
      onStatus?.(`$ ${line}`);
      await session.submit(line);
      const w = await session.waitFor({
        quietMs: +action.quiet_ms || 550,
        timeoutMs: +action.timeout_ms || 180_000,
      });
      pushScreen(messages, session, `submit wait=${w.reason} :: ${line}`);
      continue;
    }

    pushScreen(messages, session, `unknown action ${kind}`);
  }

  return { ok: false, message: 'Step limit reached.', steps: maxSteps };
}

function drainSteers(q, messages, session) {
  if (!q?.length) return;
  const lines = q.splice(0, q.length);
  messages.push({
    role: 'user',
    content: `STEER from user (obey immediately, adjust plan):\n${lines.join('\n')}\n\n--- SCREEN ---\n${session.screenText()}\n--- END ---`,
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
  return `You are Gengar — terminal AUTOPILOT (gex) inside Ghostty.

You drive a LIVE fish shell via PTY. The human watches the real terminal.
UI: only a dancing fire-Gengar sprite on the left. No other chrome.
Human typing does NOT go to the shell — it steers YOU. Enter delivers STEER.

You control the terminal like browser-control: type, tab, arrows, ctrl-c, menus, wizards.

## JSON every turn (no fences)
{
  "action": "submit" | "type" | "key" | "wait" | "done",
  "reason": "why",
  "message": "optional",
  "command": "full line for submit",
  "text": "literal keys for type",
  "key": "enter",
  "keys": ["tab","down","enter"],
  "ms": 800,
  "quiet_ms": 600,
  "timeout_ms": 120000
}

## Actions
- submit: type command + Enter (becomes real history in the driven fish session)
- type: raw characters (prompt answers, partial input)
- key / keys: enter, tab, up, down, left, right, escape, backspace, space,
  ctrl-c, ctrl-d, ctrl-u, ctrl-w, ctrl-a, ctrl-e, ctrl-l, ctrl-r, shift-tab, home, end
- wait: let output settle
- done: finished — message is the result

## Pilot rules
1. Read SCREEN (prompts, fzf, npm wizards, errors).
2. Drive interactive UI with key/type — never ask the user to finish a wizard.
3. When YOU launch tools, prefer fully-flagged non-interactive commands:
   npx --yes create-next-app@latest <name> --ts --tailwind --eslint --app --src-dir --import-alias '@/*' --turbopack --use-npm --disable-git
4. STEER messages override your plan immediately.
5. Info tasks (stats): submit command, read screen, done with findings.
6. One atomic action per turn. Keep going until done.

## Safety
No sudo / rm -rf / / force-push / curl|sh unless user explicitly demanded.
ctrl-c to abort stuck processes, then continue.

Task: ${task}`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
