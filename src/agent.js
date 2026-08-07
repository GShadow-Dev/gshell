import { sleep } from './keys.js';
import { rewriteCommand, promptAfterMark } from './pilot/watch.js';
import { InteractiveAutopilot } from './pilot/interactive.js';
import {
  runParallel,
  formatParallelBoard,
  defaultConcurrency,
} from './pilot/scheduler.js';
import { searchBlobs } from './memory/retrieve.js';
import { surveyMachine, formatSurvey } from './mind/survey.js';
import { Toolkit } from './mind/toolkit.js';

const API = 'https://api.deepseek.com/chat/completions';

export async function runAgent({
  session,
  task,
  apiKey,
  maxSteps = 32,
  steerQueue,
  onStatus,
  gengar,
  ledger,
  memoryPack = '',
  onProgressHex,
}) {
  const sessionEvents = [];
  const track = (kind, fields) => {
    const ev = ledger?.append(kind, fields);
    if (ev) sessionEvents.push(ev);
    return ev;
  };

  const toolkit = new Toolkit();
  const survey = surveyMachine(process.cwd());
  const surveyText = formatSurvey(survey);
  const playbook = toolkit.matchPlaybook(task);

  track('session_start', { actor: 'gex', task, cwd: process.cwd() });
  track('survey', { actor: 'gex', text: surveyText.slice(0, 2500) });

  const auto = new InteractiveAutopilot(session, {
    gengar,
    track,
    task,
    apiKey,
  });
  auto.start();

  let efficiency = playbook?.efficiency || null;
  let efficiencyLocked = false;
  const ranCommands = [];
  const tSession = Date.now();
  const progressNotes = [];

  const messages = [
    { role: 'system', content: systemPrompt() },
    {
      role: 'user',
      content: [
        `TASK:\n${task}`,
        `--- SURVEY ---\n${surveyText}`,
        `--- TOOLKIT CATALOG ---\n${toolkit.formatCatalog()}`,
        `--- PRIOR PLAYBOOK ---\n${toolkit.formatPlaybook(playbook)}`,
        `--- MEMORY ---\n${memoryPack || '(empty)'}`,
        `--- SCREEN ---\n${session.screenText()}`,
        efficiency
          ? `--- SEEDED EFFICIENCY ---\n${JSON.stringify(efficiency)}\nYou may efficiency_accept:true or replace with a better efficiency object.`
          : '--- SEEDED EFFICIENCY ---\n(none)',
        'Before any submit/parallel/install: include efficiency{...} OR efficiency_accept:true.',
        'Prefer the best tool for the job. If the best tool is missing and can_install allows it, action=install first (e.g. tree for directory trees, not ls -R).',
      ].join('\n\n'),
    },
  ];

  try {
    for (let step = 1; step <= maxSteps; step++) {
      drainSteers(steerQueue, messages, session, track, gengar);
      gengar?.setState('thinking', `${step}/${maxSteps}`);
      onStatus?.(`step ${step}/${maxSteps}`);

      const action = await callModel(apiKey, messages);
      messages.push({ role: 'assistant', content: JSON.stringify(action) });

      if (action.efficiency && typeof action.efficiency === 'object') {
        efficiency = action.efficiency;
        efficiencyLocked = true;
        track('efficiency', {
          actor: 'gex',
          text: JSON.stringify(efficiency).slice(0, 2500),
        });
        gengar?.setState('awake', 'efficiency');
      } else if (action.efficiency_accept && efficiency) {
        efficiencyLocked = true;
        track('efficiency', { actor: 'gex', text: 'accept_seed' });
      }

      if (
        !efficiencyLocked &&
        step <= 2 &&
        !['done', 'reply', 'memory_search'].includes(action.action)
      ) {
        if (!action.efficiency && !action.efficiency_accept) {
          messages.push({
            role: 'user',
            content:
              'REJECTED: need efficiency card first. Ask yourself: what is the best tool for THIS task given SURVEY? Is a better tool missing that we should install? Chain? Parallel? Then emit efficiency{goal,approach,tools,best_tool,steps,parallel,concurrency,install,progressive_hex,risk,why} and your next action.',
          });
          continue;
        }
      }

      track('gex_act', {
        actor: 'gex',
        action: action.action,
        cmd: action.command || action.text || action.install_cmd || '',
      });

      const kind = action.action || 'done';

      // --- INSTALL better tool (system-wide equip) ---
      if (kind === 'install') {
        let icmd =
          action.command ||
          action.install_cmd ||
          (action.bin || action.tool
            ? toolkit.installCommand(action.bin || action.tool, survey)
            : null) ||
          efficiency?.install?.cmd ||
          null;

        if (!icmd && (action.bin || action.tool || efficiency?.install?.bin)) {
          icmd = toolkit.installCommand(
            action.bin || action.tool || efficiency.install.bin,
            survey,
          );
        }

        if (!icmd) {
          messages.push({
            role: 'user',
            content:
              'install failed to resolve a command. Provide command: "brew install tree" (or cargo/npm/uv/go) based on can_install in SURVEY.',
          });
          continue;
        }

        icmd = rewriteCommand(icmd);
        gengar?.act(clip(icmd, 40));
        const mark = session.buffer.length;
        track('cmd_start', { actor: 'gex', cmd: icmd, tags: ['install'] });
        await session.submit(icmd);
        const r = await watchUntilPrompt(session, {
          mark,
          gengar,
          steerQueue,
          auto,
          timeoutMs: +action.timeout_ms || 600_000,
        });
        const out = session.screenText(14000);
        ledger?.putBlob(out, 'install');
        track('cmd_end', {
          actor: 'gex',
          cmd: icmd,
          exit: r.exitHint,
          tags: ['install'],
        });
        ranCommands.push(icmd);

        const binName = normBin(
          action.bin || action.tool || efficiency?.install?.bin || guessBin(icmd),
        );
        if (binName) {
          toolkit.noteTool(binName, {
            installed: true,
            used: true,
            purpose: action.why || efficiency?.install?.why || efficiency?.goal || '',
            install_cmd: icmd,
          });
          // refresh survey bins after install
          survey.path_bins = Array.from(
            new Set([...(survey.path_bins || []), binName]),
          ).sort();
        }

        messages.push({
          role: 'user',
          content: `TOOL_RESULT install reason=${r.reason} bin=${binName || '?'}\n$ ${icmd}\n--- SCREEN ---\n${out}\n\nContinue the task with the new tool if install succeeded.`,
        });
        continue;
      }

      if (kind === 'done' || kind === 'reply') {
        const msg = action.message || action.reason || 'Done.';
        const finalMsg =
          progressNotes.length > 0
            ? `${progressNotes.map((p, i) => `[mid-${i + 1}] ${p}`).join('\n\n')}\n\n${msg}`
            : msg;
        track('gex_reply', { actor: 'gex', text: finalMsg });
        gengar?.setState('speaking', 'hex');
        toolkit.recordWin({
          task,
          efficiency,
          commands: ranCommands,
          wall_ms: Date.now() - tSession,
          ok: true,
        });
        return {
          ok: true,
          message: finalMsg,
          steps: step,
          sessionEvents,
          autoLog: auto.log,
          efficiency,
          commands: ranCommands,
        };
      }

      if (kind === 'progress_hex' || kind === 'partial_hex') {
        const note = action.message || action.text || '';
        if (note) {
          progressNotes.push(note);
          track('progress_hex', { actor: 'gex', text: note });
          gengar?.setState('speaking', 'update');
          onProgressHex?.(note);
          messages.push({
            role: 'user',
            content: `PROGRESS_HEX shown to user. Continue until task complete.\n--- SCREEN ---\n${session.screenText()}`,
          });
        }
        continue;
      }

      if (kind === 'memory_search') {
        const q = action.query || action.text || task;
        gengar?.setState('thinking', 'recall');
        const hits = searchBlobs(ledger, q, 4);
        messages.push({
          role: 'user',
          content: `MEMORY_RESULT q=${q}\n${
            hits.map((h) => `ref=${h.ref}\n${h.lines.join('\n')}`).join('\n---\n') ||
            '(no hits)'
          }\n--- SCREEN ---\n${session.screenText()}`,
        });
        continue;
      }

      if (kind === 'wait') {
        const ms = Math.max(100, Math.min(20_000, +action.ms || 700));
        gengar?.setState('watching', `${ms}ms`);
        await session.waitFor({ quietMs: ms, timeoutMs: ms + 400 });
        pushScreen(messages, session, `wait auto=${fmtAuto(auto)}`);
        continue;
      }

      if (kind === 'key') {
        const keys = action.keys || (action.key ? [action.key] : []);
        if (
          auto.answeredConfirm &&
          keys.length === 1 &&
          /^(y|enter)$/i.test(keys[0])
        ) {
          pushScreen(messages, session, 'key skipped — already confirmed');
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
          pushScreen(messages, session, 'type skipped — already confirmed');
          continue;
        }
        gengar?.act(clip(text, 24));
        await session.type(text, { delayMs: +action.delay_ms || 0 });
        await session.waitFor({ quietMs: 250, timeoutMs: 10_000 });
        pushScreen(messages, session, `type auto=${fmtAuto(auto)}`);
        continue;
      }

      if (kind === 'parallel' || kind === 'fanout') {
        const jobs = normalizeJobs(action.jobs || action.commands || []);
        if (!jobs.length) {
          messages.push({
            role: 'user',
            content: 'parallel needs jobs:[{id,cmd}] or commands:[string]',
          });
          continue;
        }
        const conc =
          +action.concurrency ||
          +efficiency?.concurrency ||
          defaultConcurrency(survey.cpus || 4);
        gengar?.setState('watching', `swarm 0/${jobs.length}`);
        track('parallel_start', {
          actor: 'gex',
          text: jobs.map((j) => j.cmd).join(' || ').slice(0, 1500),
        });

        const results = await runParallel(jobs, {
          concurrency: conc,
          cwd: process.cwd(),
          timeoutMs: +action.timeout_ms || 900_000,
          onUpdate: (u) => {
            if (u.total) {
              gengar?.setState(
                'watching',
                `swarm ${u.done || 0}/${u.total} live=${u.live || 0}`,
              );
            }
          },
        });

        for (const r of results) {
          ranCommands.push(r.cmd);
          const ref = ledger?.putBlob(r.out || '', `p-${r.id}`);
          track('cmd_end', {
            actor: 'gex',
            cmd: r.cmd,
            exit: r.code,
            duration_ms: r.ms,
            blob_ref: ref,
            tags: ['parallel'],
          });
        }

        const board = formatParallelBoard(results);
        messages.push({
          role: 'user',
          content: `TOOL_RESULT parallel conc=${conc}\n${board}\n\nContinue, progress_hex, or done.`,
        });
        continue;
      }

      if (kind === 'submit') {
        const line = rewriteCommand(action.command || action.text || '');
        auto.answeredConfirm = false;
        gengar?.act(clip(line, 40));
        track('cmd_start', { actor: 'gex', cmd: line });
        const t0 = Date.now();
        const mark = session.buffer.length;
        await session.submit(line);

        const result = await watchUntilPrompt(session, {
          mark,
          gengar,
          steerQueue,
          auto,
          timeoutMs: +action.timeout_ms || 900_000,
        });

        const out = session.screenText(16000);
        const ref = ledger?.putBlob(out, 'cmd');
        track('cmd_end', {
          actor: 'gex',
          cmd: line,
          exit: result.exitHint,
          duration_ms: Date.now() - t0,
          blob_ref: ref,
          auto: fmtAuto(auto),
        });
        ranCommands.push(line);

        const bin = guessBin(line);
        if (bin) toolkit.noteTool(bin, { used: true });

        messages.push({
          role: 'user',
          content: `TOOL_RESULT submit reason=${result.reason} elapsed_ms=${
            Date.now() - t0
          } auto=${fmtAuto(auto)}\n$ ${line}\n--- SCREEN ---\n${out}`,
        });

        if (auto.cancelled && auto.cleanupIntent) {
          messages.push({
            role: 'user',
            content:
              'NOTE: Autopilot sent ctrl-c. Cleanup leftovers if needed, then done.',
          });
        }
        continue;
      }

      pushScreen(messages, session, `unknown action ${kind}`);
    }

    toolkit.recordWin({
      task,
      efficiency,
      commands: ranCommands,
      wall_ms: Date.now() - tSession,
      ok: false,
    });
    return {
      ok: false,
      message: 'Step limit reached.',
      steps: maxSteps,
      sessionEvents,
      autoLog: auto.log,
      efficiency,
      commands: ranCommands,
    };
  } finally {
    auto.stop();
  }
}

function normalizeJobs(jobs) {
  if (!Array.isArray(jobs)) return [];
  return jobs
    .map((j, i) => {
      if (typeof j === 'string') return { id: `j${i + 1}`, cmd: j };
      if (j?.cmd) return { id: j.id || `j${i + 1}`, cmd: String(j.cmd), cwd: j.cwd };
      return null;
    })
    .filter(Boolean);
}

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

  while (Date.now() - start < timeoutMs) {
    if (steerQueue?.length) return { reason: 'steer', exitHint: null };
    if (session.exited) return { reason: 'exited', exitHint: session.exitCode };

    const len = session.buffer.length;
    if (len !== lastLen) {
      lastLen = len;
      lastGrowth = Date.now();
    }

    if (promptAfterMark(session, mark) && Date.now() - lastGrowth >= 450) {
      return {
        reason: auto.cancelled ? 'cancelled' : 'prompt',
        exitHint: auto.cancelled ? 130 : 0,
      };
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
      gengar?.setState(
        'watching',
        clip(snap ? `${tag} ${s}s · ${snap}` : `${tag} ${s}s`, 48),
      );
      lastBeat = now;
    }

    if (now - lastGrowth >= 15000 && now - lastTickLine >= 15000) {
      gengar?.act(`still watching ${Math.round((now - start) / 1000)}s`);
      lastTickLine = now;
    }

    await sleep(100);
  }
  return { reason: 'timeout', exitHint: null };
}

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
  for (const l of lines.slice(-8).reverse()) {
    if (/(stats:|%|etc:|done|error|warn|report|elapsed|built|pass|fail)/i.test(l)) {
      last = l;
      break;
    }
  }
  last = last.replace(/\s+/g, ' ');
  return last.length > 36 ? `${last.slice(0, 34)}…` : last;
}

function guessBin(cmd) {
  const tok = String(cmd || '')
    .trim()
    .split(/\s+/)
    .find((t) => t && !t.includes('=') && !t.startsWith('-'));
  return tok ? pathBasename(tok) : '';
}

function pathBasename(s) {
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

function normBin(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9._+-]/g, '')
    .slice(0, 48);
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
    content: `STEER from user (obey immediately):\n${lines.join('\n')}\n\n--- SCREEN ---\n${session.screenText()}`,
  });
}

function pushScreen(messages, session, note) {
  messages.push({
    role: 'user',
    content: `TOOL_RESULT ${note}\n--- SCREEN ---\n${session.screenText()}`,
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
      temperature: 0.12,
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

function systemPrompt() {
  return `You are Gengar — system-wide terminal AUTOPILOT (gex).

You handle ANY task. Never assume a scenario. Use TASK + SURVEY + TOOLKIT + PLAYBOOK + MEMORY + SCREEN only.

## Core principle: best tool for the job
Prefer the right tool over clever abuse of a worse one.
Examples of the *principle* (not a checklist to hardcode):
- directory tree → install/use tree (not ls -R)
- fuzzy find → fzf/fd if available or install
- JSON → jq
- HTTP load → the right benchmark tool if needed
If the best tool is missing and SURVEY.can_install allows it, action=install FIRST, then use it.
Record installs in toolkit so next time PATH already has it.

## Efficiency card (required before heavy work)
{
  "goal": "success criteria",
  "approach": "strategy",
  "best_tool": "primary binary",
  "tools": ["..."],
  "steps": ["..."],
  "parallel": false,
  "concurrency": 2,
  "install": null or { "bin": "tree", "cmd": "brew install tree", "why": "best UX for trees" },
  "progressive_hex": false,
  "risk": "green|amber|red",
  "why": "why this is most efficient"
}
Or efficiency_accept:true to accept seeded playbook.

Self-ask every task:
1) What is the actual success condition?
2) What is the best tool GIVEN path_bins / can_install?
3) Should I install a better tool?
4) Best flags/params?
5) Chain vs parallel fan-out?
6) Progressive updates for long work?

## Actions (JSON only)
- install — equip a better tool (command or bin+auto brew/cargo/npm/uv/go)
- submit — run one foreground command; host waits until NEW prompt
- parallel — {jobs:[{id,cmd}] or commands:[...], concurrency?} any independent units
- progress_hex — mid-flight user update
- type | key | wait — interaction
- memory_search — dig room memory
- done — final HEX

Interactive y/n, menus, "type DELETE" answered by a FAST side AI on the byte stream.

## Rules
- SURVEY.path_bins is ground truth for what exists.
- Install only when ROI is real (better tool / clearer output / big time win).
- Prefer parallel when work units are independent.
- No sudo/rm -rf //force-push/curl|sh unless user demanded.
- Password → don't invent; ask user / done.
- After success, done with a clear summary.
`;
}

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
