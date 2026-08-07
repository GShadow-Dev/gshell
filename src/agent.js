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
import { SYSTEM, userBrief, REJECT } from './prompts.js';

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
  /** @type {Map<string, {n:number, err:string}>} */
  const failMap = new Map();
  const tSession = Date.now();
  const progressNotes = [];

  const messages = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: userBrief({
        task,
        surveyText,
        catalog: toolkit.formatCatalog(),
        playbook: toolkit.formatPlaybook(playbook),
        memoryPack,
        screen: session.screenText(),
        seededEfficiency: efficiency,
      }),
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

      const kind = String(action.action || (action.efficiency ? 'plan' : ''))
        .toLowerCase()
        .trim();
      const cmdPeek = peekCmd(action);

      const reject = gate({
        kind,
        efficiencyLocked,
        hasEff: Boolean(action.efficiency || action.efficiency_accept),
        cmdPeek,
        ranCommands,
        message: action.message || action.reason || '',
        failMap,
      });
      if (reject) {
        messages.push({ role: 'user', content: reject });
        continue;
      }

      track('gex_act', { actor: 'gex', action: kind, cmd: cmdPeek });

      if (kind === 'done' || kind === 'reply') {
        const msg = String(action.message || action.reason || '').trim();
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

      if (kind === 'install') {
        let icmd =
          action.command ||
          action.install_cmd ||
          toolkit.installCommand(
            action.bin || action.tool || efficiency?.install?.bin,
            survey,
          ) ||
          efficiency?.install?.cmd ||
          '';
        icmd = rewriteCommand(icmd);
        if (!icmd) {
          messages.push({ role: 'user', content: REJECT.installNeed });
          continue;
        }
        await execLine({
          session,
          line: icmd,
          gengar,
          steerQueue,
          auto,
          track,
          ledger,
          ranCommands,
          failMap,
          toolkit,
          survey,
          messages,
          timeoutMs: +action.timeout_ms || 600_000,
          tags: ['install'],
          binHint: action.bin || action.tool || efficiency?.install?.bin,
          purpose: action.why || efficiency?.install?.why || '',
        });
        continue;
      }

      if (kind === 'progress_hex' || kind === 'partial_hex') {
        const note = String(action.message || action.text || '').trim();
        if (note.length >= 12) {
          progressNotes.push(note);
          track('progress_hex', { actor: 'gex', text: note });
          gengar?.setState('speaking', 'update');
          onProgressHex?.(note);
        }
        messages.push({
          role: 'user',
          content: `${REJECT.afterProgress}\n--- SCREEN ---\n${session.screenText()}`,
        });
        continue;
      }

      if (kind === 'memory_search') {
        const q = action.query || action.text || task;
        gengar?.setState('thinking', 'recall');
        const hits = searchBlobs(ledger, q, 4);
        messages.push({
          role: 'user',
          content: `TOOL_RESULT memory q=${q}\n${
            hits.map((h) => `${h.ref}\n${h.lines.join('\n')}`).join('\n---\n') ||
            '∅'
          }\n--- SCREEN ---\n${session.screenText()}\n\n${REJECT.afterTool}`,
        });
        continue;
      }

      if (kind === 'wait') {
        const ms = Math.max(100, Math.min(20_000, +action.ms || 700));
        gengar?.setState('watching', `${ms}ms`);
        await session.waitFor({ quietMs: ms, timeoutMs: ms + 400 });
        messages.push({
          role: 'user',
          content: `TOOL_RESULT wait auto=${fmtAuto(auto)}\n--- SCREEN ---\n${session.screenText()}\n\n${REJECT.afterTool}`,
        });
        continue;
      }

      if (kind === 'key') {
        const keys = action.keys || (action.key ? [action.key] : []);
        if (
          auto.answeredConfirm &&
          keys.length === 1 &&
          /^(y|enter)$/i.test(keys[0])
        ) {
          messages.push({
            role: 'user',
            content: `TOOL_RESULT key skipped\n--- SCREEN ---\n${session.screenText()}\n\n${REJECT.afterTool}`,
          });
          continue;
        }
        gengar?.act(keys.join(' '));
        for (const k of keys) {
          await session.key(k);
          await sleep(35);
        }
        await session.waitFor({ quietMs: 300, timeoutMs: 15_000 });
        messages.push({
          role: 'user',
          content: `TOOL_RESULT key ${keys.join(',')} auto=${fmtAuto(auto)}\n--- SCREEN ---\n${session.screenText()}\n\n${REJECT.afterTool}`,
        });
        continue;
      }

      if (kind === 'type') {
        const text = String(action.text ?? '');
        if (auto.answeredConfirm && /^y(es)?$/i.test(text.trim())) {
          messages.push({
            role: 'user',
            content: `TOOL_RESULT type skipped\n--- SCREEN ---\n${session.screenText()}\n\n${REJECT.afterTool}`,
          });
          continue;
        }
        gengar?.act(clip(text, 24));
        await session.type(text, { delayMs: +action.delay_ms || 0 });
        await session.waitFor({ quietMs: 250, timeoutMs: 10_000 });
        messages.push({
          role: 'user',
          content: `TOOL_RESULT type auto=${fmtAuto(auto)}\n--- SCREEN ---\n${session.screenText()}\n\n${REJECT.afterTool}`,
        });
        continue;
      }

      if (kind === 'parallel' || kind === 'fanout') {
        const jobs = normalizeJobs(action.jobs || action.commands || []);
        if (!jobs.length) {
          messages.push({ role: 'user', content: REJECT.parallelEmpty });
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
          if (r.cmd?.trim()) ranCommands.push(r.cmd);
          ledger?.putBlob(r.out || '', `p-${r.id}`);
          track('cmd_end', {
            actor: 'gex',
            cmd: r.cmd,
            exit: r.code,
            duration_ms: r.ms,
            tags: ['parallel'],
          });
          const b = guessBin(r.cmd);
          if (b) toolkit.noteTool(b, { used: true });
        }

        messages.push({
          role: 'user',
          content: `TOOL_RESULT parallel conc=${conc}\n${formatParallelBoard(
            results,
          )}\n\n${REJECT.afterTool}`,
        });
        continue;
      }

      if (kind === 'submit') {
        const line = rewriteCommand(action.command || action.text || '');
        if (!line) {
          messages.push({ role: 'user', content: REJECT.emptySubmit });
          continue;
        }
        await execLine({
          session,
          line,
          gengar,
          steerQueue,
          auto,
          track,
          ledger,
          ranCommands,
          failMap,
          toolkit,
          survey,
          messages,
          timeoutMs: +action.timeout_ms || 900_000,
          tags: [],
        });
        if (auto.cancelled && auto.cleanupIntent) {
          messages.push({ role: 'user', content: REJECT.afterCancel });
        }
        continue;
      }

      if (kind === 'done' || kind === 'reply') {
        // handled above
        continue;
      }

      messages.push({ role: 'user', content: REJECT.unknown(kind) });
    }

    return {
      ok: false,
      message: ranCommands.length
        ? `Step limit. Ran: ${ranCommands.join(' · ')}`
        : 'Step limit; no commands run.',
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

function gate({ kind, efficiencyLocked, hasEff, cmdPeek, ranCommands, message, failMap }) {
  if (!kind || kind === 'plan') {
    return efficiencyLocked ? REJECT.planOnly : REJECT.needEfficiency;
  }

  if (!efficiencyLocked && !hasEff && !['memory_search'].includes(kind)) {
    return REJECT.needEfficiency;
  }

  if (kind === 'done' || kind === 'reply') {
    const worked = ranCommands.some((c) => String(c || '').trim());
    const msg = String(message || '').trim();
    const hollow = !msg || /^done\.?$/i.test(msg) || msg.length < 24;
    const chatty = /^(hi|hello|hey)\b/i.test(msg) && msg.length < 80;
    if (!worked && !chatty) return REJECT.doneNoWork;
    if (worked && hollow) return REJECT.doneHollow;
    if (!worked && hollow) return REJECT.doneNoWork;
  }

  if (kind === 'submit' || kind === 'install') {
    const line = String(cmdPeek || '').trim();
    if (!line) return REJECT.emptySubmit;
    const fails = failMap?.get(line);
    if (fails && fails.n >= 2) {
      return REJECT.repeatFail(line, fails.n, fails.err);
    }
  }

  return null;
}

async function execLine({
  session,
  line,
  gengar,
  steerQueue,
  auto,
  track,
  ledger,
  ranCommands,
  failMap,
  toolkit,
  survey,
  messages,
  timeoutMs,
  tags = [],
  binHint = '',
  purpose = '',
}) {
  auto.answeredConfirm = false;
  gengar?.act(clip(line, 40));
  track('cmd_start', { actor: 'gex', cmd: line, tags });
  const t0 = Date.now();
  const mark = session.buffer.length;
  await session.submit(line);
  const result = await watchUntilPrompt(session, {
    mark,
    gengar,
    steerQueue,
    auto,
    timeoutMs,
  });
  const out = session.screenText(16000);
  const errTail = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /error|failed|not found|syntax|denied|quitting|usage:/i.test(l))
    .slice(-4)
    .join(' | ');

  // failure loop accounting: exit!=0 or obvious error lines
  const failed =
    (result.exitHint != null && result.exitHint !== 0) ||
    /syntax error|not found|failed|quitting!/i.test(out.slice(-1500));
  if (failed) {
    const prev = failMap?.get(line) || { n: 0, err: '' };
    failMap?.set(line, { n: prev.n + 1, err: errTail || prev.err || 'nonzero exit' });
  } else {
    failMap?.delete(line);
  }

  ledger?.putBlob(out, tags.includes('install') ? 'install' : 'cmd');
  track('cmd_end', {
    actor: 'gex',
    cmd: line,
    exit: result.exitHint,
    duration_ms: Date.now() - t0,
    tags,
    auto: fmtAuto(auto),
  });
  ranCommands.push(line);
  const bin = normBin(binHint || guessBin(line));
  if (bin) {
    toolkit.noteTool(bin, {
      installed: tags.includes('install') || undefined,
      used: true,
      purpose,
      install_cmd: tags.includes('install') ? line : undefined,
    });
    if (survey?.path_bins) {
      survey.path_bins = Array.from(new Set([...survey.path_bins, bin])).sort();
    }
  }

  const failNote = failed
    ? `\nFAIL count for this exact command: ${failMap?.get(line)?.n || 1}. Do NOT retry the same command. Change approach.`
    : '';

  messages.push({
    role: 'user',
    content: `TOOL_RESULT ${tags.includes('install') ? 'install' : 'submit'} reason=${result.reason} ms=${Date.now() - t0} auto=${fmtAuto(auto)}\n$ ${line}\n--- SCREEN ---\n${out}${failNote}\n\n${REJECT.afterTool}`,
  });
}

function normalizeJobs(jobs) {
  if (!Array.isArray(jobs)) return [];
  return jobs
    .map((j, i) => {
      if (typeof j === 'string' && j.trim()) return { id: `j${i + 1}`, cmd: j.trim() };
      if (j?.cmd && String(j.cmd).trim()) {
        return { id: j.id || `j${i + 1}`, cmd: String(j.cmd).trim(), cwd: j.cwd };
      }
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

function peekCmd(a) {
  return (
    first(
      a.command,
      a.install_cmd,
      a.text,
      Array.isArray(a.commands) ? a.commands[0] : '',
      Array.isArray(a.jobs) ? a.jobs[0]?.cmd : '',
    ) || ''
  );
}

function first(...xs) {
  for (const x of xs) {
    if (x != null && String(x).trim()) return String(x).trim();
  }
  return '';
}

function guessBin(cmd) {
  const tok = String(cmd || '')
    .trim()
    .split(/\s+/)
    .find((t) => t && !t.includes('=') && !t.startsWith('-'));
  if (!tok) return '';
  const i = Math.max(tok.lastIndexOf('/'), tok.lastIndexOf('\\'));
  return i >= 0 ? tok.slice(i + 1) : tok;
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
    content: `STEER\n${lines.join('\n')}\n--- SCREEN ---\n${session.screenText()}`,
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
    return {
      action: 'submit',
      command: 'uptime && df -h / | tail -1',
      efficiency: {
        goal: 'recover from bad JSON',
        best_tool: 'uptime',
        approach: 'basic probe',
        tools: ['uptime', 'df'],
        steps: ['probe'],
        parallel: false,
        install: null,
        progressive_hex: false,
        risk: 'green',
        why: 'parse fallback',
      },
    };
  }
}

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
