import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep } from './keys.js';
import { stripAnsi } from './pty_session.js';
import { rewriteCommand, promptAfterMark } from './pilot/watch.js';
import { InteractiveAutopilot } from './pilot/interactive.js';
import { formatParallelBoard } from './pilot/scheduler.js';
import { searchBlobs } from './memory/retrieve.js';
import { surveyMachine, formatSurvey } from './mind/survey.js';
import { Toolkit } from './mind/toolkit.js';
import { gsearch, formatGsearch, detectGsearch } from './mind/gsearch.js';
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
  // $SHELL is unreliable (often stale login-shell metadata); report the
  // shell actually driving this PTY so the model's quoting/syntax matches.
  survey.shell = session.shell || survey.shell;
  const surveyText = formatSurvey(survey);
  const playbook = toolkit.matchPlaybook(task);

  // Advertise GSearch only when a backend is actually reachable — the model
  // must never be told it has a tool that will fail.
  let gsAvail = { context7: false, firecrawl: false };
  try {
    gsAvail = await detectGsearch();
  } catch {
    /* offline — local discovery still works */
  }

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
  /** @type {Map<string, {n:number, err:string, bin:string}>} */
  const failMap = new Map();
  const tSession = Date.now();
  const progressNotes = [];
  /**
   * Loop health. `ok`/`fail` gate playbook recording (a failed session must
   * never be saved as a winning recipe). `lastFailed` drives the forced
   * diagnosis step so failure is re-diagnosed, not just reacted to.
   */
  const runState = {
    ok: 0,
    fail: 0,
    lastFailed: false,
    lastError: '',
    diagnosisAsked: false,
    verifyAsked: false,
    discovered: 0,
    discoverTried: false,
    gsearchTried: false,
    gsearchAsked: false,
  };
  /**
   * Every batch ever issued, by signature. Re-running an IDENTICAL batch is a
   * loop even when it prints plenty of output — a job that always succeeds
   * (`system_profiler | head`) otherwise masks the fact that nothing is
   * progressing. Repetition, not failure, is the signal here.
   */
  const issuedBatches = new Map();

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
        gsearch: gsAvail,
      }),
    },
  ];

  let rejects = 0;
  const MAX_REJECTS = 10;

  try {
    for (let step = 1; step <= maxSteps; step++) {
      drainSteers(steerQueue, messages, session, track, gengar);
      gengar?.setState('thinking', `${step}/${maxSteps}`);
      onStatus?.(`step ${step}/${maxSteps}`);

      compactMessages(messages);
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
        action,
        runState,
        issuedBatches,
      });
      if (reject) {
        rejects++;
        track('reject', { actor: 'gex', text: reject.slice(0, 300) });
        // Visible: a rejected turn costs wall-clock but shows nothing in the
        // terminal, which reads as "gex froze". Say so, dimly, once per reject.
        process.stderr.write(
          `\x1b[38;2;95;104;115m  gex: retry — ${clip(firstLine(reject), 84)}\x1b[0m\n`,
        );
        messages.push({ role: 'user', content: reject });
        if (rejects >= MAX_REJECTS) {
          return {
            ok: false,
            message: `Stopped: ${rejects} malformed/blocked turns in a row without productive work.`,
            steps: step,
            sessionEvents,
            autoLog: auto.log,
            efficiency,
            commands: ranCommands,
          };
        }
        // A rejected turn produced no work — don't spend the action budget on it.
        step--;
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
        // Only record a playbook when work actually succeeded. A session that
        // ended in "I couldn't do it" must never be replayed as a winning
        // recipe — that was poisoning future runs with the losing approach.
        const reallyWon = runState.ok > 0 && runState.ok >= runState.fail;
        if (reallyWon) {
          toolkit.recordWin({
            task,
            efficiency,
            commands: ranCommands,
            wall_ms: Date.now() - tSession,
            ok: true,
          });
        }
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
          runState,
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

      // GSearch — off-machine evidence, same triangulation doctrine. Several
      // DIFFERENT phrasings are issued concurrently and only identifiers that
      // appear in 2+ independent sources are promoted as agreed. Results are
      // tier-tagged so on-machine truth always outranks a scraped page.
      if (kind === 'gsearch' || kind === 'lookup') {
        const angles = []
          .concat(action.angles || action.queries || action.query || [])
          .map((a) => String(a || '').trim())
          .filter(Boolean)
          .slice(0, 5);
        if (!angles.length) {
          messages.push({ role: 'user', content: REJECT.gsearchEmpty });
          continue;
        }
        runState.gsearchTried = true;
        const gsig = `gsearch:${angles.slice().sort().join('|')}`.slice(0, 400);
        if ((issuedBatches.get(gsig) || 0) >= 2) {
          messages.push({ role: 'user', content: REJECT.repeatDiscover(2) });
          continue;
        }
        issuedBatches.set(gsig, (issuedBatches.get(gsig) || 0) + 1);

        const sites = []
          .concat(action.sites || action.domains || [])
          .map((x) => String(x || '').trim())
          .filter(Boolean);
        gengar?.setState('thinking', `gsearch ${angles.length} angles`);
        // Network lookups are not terminal commands, but they must still be
        // visible — the user has to see everything gex does.
        process.stderr.write(
          `\x1b[38;2;89;208;216m  gsearch:\x1b[0m ${clip(angles.join(' | '), 96)}\n`,
        );
        track('gsearch', { actor: 'gex', text: angles.join(' | ').slice(0, 500) });

        let out;
        try {
          out = await gsearch({ angles, topic: action.topic || task, sites });
        } catch (err) {
          out = { available: {}, results: [], agreed: [], error: err.message };
        }
        const agreedN = out.agreed?.length || 0;
        ledger?.putBlob(formatGsearch(out), 'gsearch');
        messages.push({
          role: 'user',
          content: `TOOL_RESULT gsearch angles=${angles.length} agreed=${agreedN}\n${formatGsearch(out)}\n\n${REJECT.afterGsearch}`,
        });
        continue;
      }

      // Triangulated discovery: run several INDEPENDENT read-only probes at
      // once and cross-check them. One probe failing (a missing wrapper like
      // `sdef`) must not end discovery — a different angle usually still
      // reaches the same ground truth. Probes never enter the fail-map, so
      // exploring costs nothing against the "change approach" pressure.
      if (kind === 'discover' || kind === 'probe') {
        const probes = normalizeJobs(action.probes || action.jobs || action.commands || []);
        if (!probes.length) {
          messages.push({ role: 'user', content: REJECT.discoverEmpty });
          continue;
        }
        runState.discoverTried = true;
        const dsigKey = batchSignature(probes);
        issuedBatches.set(dsigKey, (issuedBatches.get(dsigKey) || 0) + 1);
        gengar?.setState('watching', `discover 0/${probes.length}`);
        track('discover_start', {
          actor: 'gex',
          text: `${action.goal || ''} :: ${probes.map((p) => p.cmd).join(' || ')}`.slice(0, 1500),
        });

        const results = await runParallelInPty(session, probes, {
          gengar,
          steerQueue,
          auto,
          timeoutMs: +action.timeout_ms || 300_000,
        });

        for (const r of results) {
          if (r.cmd?.trim()) ranCommands.push(r.cmd);
          ledger?.putBlob(r.out || '', `d-${r.id}`);
          track('cmd_end', {
            actor: 'gex',
            cmd: r.cmd,
            exit: r.code,
            tags: ['discover'],
          });
        }
        const hits = results.filter((r) => r.code === 0 && String(r.out || '').trim());
        runState.discovered += hits.length;
        // A probe batch that surfaced nothing is a dead set of angles.
        // Record it so repeating the same probes gets blocked.
        const dsig = batchSignature(probes);
        if (!hits.length) {
          const prev = failMap.get(dsig) || { n: 0, err: '', bin: '' };
          failMap.set(dsig, {
            n: prev.n + 1,
            err: 'all probes returned nothing — change the angles',
            bin: '',
          });
        } else {
          failMap.delete(dsig);
        }
        // Discovery output is evidence, not a result — a probe that returns
        // nothing is a dead angle, not a failed task.
        messages.push({
          role: 'user',
          content: `TOOL_RESULT discover goal=${clip(String(action.goal || ''), 120)} probes=${probes.length} withOutput=${hits.length}\n${formatParallelBoard(results)}\n\n${REJECT.afterDiscover}`,
        });
        continue;
      }

      if (kind === 'parallel' || kind === 'fanout') {
        const jobs = normalizeJobs(action.jobs || action.commands || []);
        if (!jobs.length) {
          messages.push({ role: 'user', content: REJECT.parallelEmpty });
          continue;
        }
        const psigKey = batchSignature(jobs);
        issuedBatches.set(psigKey, (issuedBatches.get(psigKey) || 0) + 1);
        gengar?.setState('watching', `swarm 0/${jobs.length}`);
        track('parallel_start', {
          actor: 'gex',
          text: jobs
            .map((j) => j.cmd)
            .join(' || ')
            .slice(0, 1500),
        });

        const t0p = Date.now();
        const results = await runParallelInPty(session, jobs, {
          gengar,
          steerQueue,
          auto,
          timeoutMs: +action.timeout_ms || 900_000,
        });
        const wallMs = Date.now() - t0p;

        for (const r of results) {
          r.ms = wallMs;
          if (r.cmd?.trim()) ranCommands.push(r.cmd);
          ledger?.putBlob(r.out || '', `p-${r.id}`);
          track('cmd_end', {
            actor: 'gex',
            cmd: r.cmd,
            exit: r.code,
            duration_ms: r.ms,
            tags: ['parallel'],
          });
        }

        const board = formatParallelBoard(results);
        const useful = results.filter(
          (r) => r.code === 0 && String(r.out || '').trim(),
        );
        const psig = batchSignature(jobs);
        if (!useful.length) {
          const prev = failMap.get(psig) || { n: 0, err: '', bin: '' };
          failMap.set(psig, {
            n: prev.n + 1,
            err: 'batch produced no usable output',
            bin: '',
          });
          runState.fail += 1;
          runState.lastFailed = true;
          runState.lastError = 'parallel batch produced no usable output';
          runState.diagnosisAsked = false;
        } else {
          failMap.delete(psig);
          runState.ok += 1;
          runState.lastFailed = false;
        }
        messages.push({
          role: 'user',
          content: `TOOL_RESULT parallel jobs=${jobs.length} withOutput=${useful.length}\n${board}\n\n${
            useful.length
              ? REJECT.afterTool
              : 'Every job returned empty. Do NOT repeat this same batch — the approach is wrong, not the timing. Change what you are looking for or how you look for it.'
          }`,
        });
        continue;
      }

      if (kind === 'submit') {
        let line = rewriteCommand(action.command || action.text || '');
        // Models often emit \\n instead of real newlines for heredocs/scripts.
        if (line && !line.includes('\n') && /\\n/.test(line)) {
          line = line.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        }
        // Optional script body → temp file. General (any interpreter).
        // {"action":"submit","command":"osascript","script":"…"}
        // {"action":"submit","command":"python3","script":"…"}
        const scriptBody = first(
          action.script,
          action.body,
          action.stdin,
          action.applescript,
        );
        let scriptTmpPath = '';
        let scriptBin = '';
        if (scriptBody) {
          const materialized = materializeScript(line || 'bash', scriptBody);
          line = materialized.line;
          scriptTmpPath = materialized.tmpPath;
          scriptBin = materialized.bin;
        }
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
          cleanupPath: scriptTmpPath,
          binHint: scriptBin,
          runState,
        });
        if (auto.cancelled && auto.cleanupIntent) {
          messages.push({ role: 'user', content: REJECT.afterCancel });
        }
        continue;
      }

      messages.push({
        role: 'user',
        content: REJECT.unknown(kind),
      });
    }

    return {
      ok: false,
      message: 'Hit max steps without finishing.',
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

function gate({
  kind,
  efficiencyLocked,
  hasEff,
  cmdPeek,
  ranCommands,
  message,
  failMap,
  action = {},
  runState = null,
  issuedBatches = null,
}) {
  if (!kind || kind === 'plan') {
    return efficiencyLocked ? REJECT.planOnly : REJECT.needEfficiency;
  }

  if (
    !efficiencyLocked &&
    !hasEff &&
    !['memory_search', 'discover', 'probe', 'gsearch', 'lookup'].includes(kind)
  ) {
    return REJECT.needEfficiency;
  }

  // After a failure, force ONE real diagnosis before acting again. Asked at
  // most once per failure so it can never spiral into a rejection loop.
  // `discover` is exempt — going to look for ground truth IS the right move.
  if (
    runState?.lastFailed &&
    !runState.diagnosisAsked &&
    ['submit', 'install', 'parallel', 'fanout'].includes(kind)
  ) {
    const diag = String(
      action.diagnosis || action.reflection || action.why_failed || '',
    ).trim();
    if (diag.length < 24) {
      runState.diagnosisAsked = true;
      return REJECT.needDiagnosis(runState.lastError);
    }
  }

  if (kind === 'done' || kind === 'reply') {
    const worked = ranCommands.some((c) => String(c || '').trim());
    const msg = String(message || '').trim();
    const hollow = !msg || /^done\.?$/i.test(msg) || msg.length < 24;
    const chatty = /^(hi|hello|hey)\b/i.test(msg) && msg.length < 80;
    if (!worked && !chatty) return REJECT.doneNoWork;
    if (worked && hollow) return REJECT.doneHollow;
    if (!worked && hollow) return REJECT.doneNoWork;

    // Claiming the goal happened requires having OBSERVED it. Exit codes only
    // prove a command ran — that is how a track played to the wrong device
    // still got reported as success. Asked at most once so it cannot loop.
    if (worked && runState && !runState.verifyAsked) {
      const verificationEarly = String(
        action.verification || action.verified || action.evidence || '',
      ).trim();
      const verification = String(
        action.verification || action.verified || action.evidence || '',
      ).trim();
      // An INFERRED premise is not evidence. The model can run a real command
      // on top of a guessed fact ("assembled in China, most likely") and the
      // output looks verified while the answer is fabricated. Hedge words in
      // a final answer mean a link in the chain was never checked.
      const hedged =
        /\b(most likely|probably|typically|generally|usually|presumably|assume[sd]?|assuming|i believe|should be|would be|commonly|in general|likely)\b/i.test(
          msg,
        );
      if (hedged && verificationEarly.length < 20) {
        runState.verifyAsked = true;
        return REJECT.unverifiedPremise;
      }

      const claimsSuccess =
        /\b(success|succeed|worked|complete[d]?|done|playing|now (?:playing|running|set|enabled)|configured|installed|created|fixed|resolved)\b/i.test(
          msg,
        ) && !/\b(fail|could not|couldn't|unable|not achieved|no luck)\b/i.test(msg);
      if (claimsSuccess && verification.length < 20) {
        runState.verifyAsked = true;
        return REJECT.needVerification;
      }
    }
  }

  // Batch actions loop too. Without this, an identical fanout could repeat
  // forever — the fail-map only ever watched single commands. Note this
  // blocks on REPETITION, not on failure: a batch containing one
  // always-succeeds job would otherwise look productive forever.
  if (['parallel', 'fanout', 'discover', 'probe'].includes(kind)) {
    const jobs = normalizeJobs(
      action.probes || action.jobs || action.commands || [],
    );
    if (jobs.length) {
      const bsig = batchSignature(jobs);
      const seen = issuedBatches?.get(bsig) || 0;
      if (seen >= 2) {
        return ['discover', 'probe'].includes(kind)
          ? REJECT.repeatDiscover(seen)
          : REJECT.repeatBatch(seen);
      }
      const bf = failMap?.get(bsig);
      if (bf && bf.n >= 2) {
        return ['discover', 'probe'].includes(kind)
          ? REJECT.repeatDiscover(bf.n)
          : REJECT.repeatFail(`${jobs.length} jobs (same batch)`, bf.n, bf.err);
      }
    }
  }

  if (kind === 'submit' || kind === 'install') {
    const line = String(cmdPeek || '').trim();
    if (!line) return REJECT.emptySubmit;
    const sig = cmdSignature(line);
    const fails = failMap?.get(sig);
    if (fails && fails.n >= 2) {
      return REJECT.repeatFail(line, fails.n, fails.err);
    }
    // same bin failed across variants
    const bin = guessBin(line);
    if (bin && failMap) {
      let binFails = 0;
      let lastErr = '';
      for (const v of failMap.values()) {
        if (v.bin === bin) {
          binFails += v.n;
          lastErr = v.err || lastErr;
        }
      }
      if (binFails >= 3) {
        return REJECT.repeatFail(
          `${bin} … (${binFails} failures)`,
          binFails,
          lastErr || 'repeated tool failure — change approach',
        );
      }
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
  cleanupPath = '',
  runState = null,
}) {
  auto.answeredConfirm = false;
  gengar?.act(clip(line, 40));
  track('cmd_start', { actor: 'gex', cmd: line, tags });
  const t0 = Date.now();
  const mark = session.buffer.length;
  const submitResult = await session.submit(line);
  const result = await watchUntilPrompt(session, {
    mark,
    gengar,
    steerQueue,
    auto,
    timeoutMs,
  });
  // Only THIS command's output — not the whole scrollback. Feeding the entire
  // screen back every turn meant the model kept re-reading its own earlier
  // failures, which is exactly the pattern that made it repeat them.
  const out = deltaText(session, mark, 14000);
  const exitCode = inferExit(out, result.exitHint);
  const errTail = extractErrors(out);
  const sig = cmdSignature(line);
  const bin = normBin(binHint || guessBin(line));

  // Delete any temp script file from Node directly — never as a chained
  // shell `rm`, which would overwrite the real exit status we just read.
  for (const p of [cleanupPath, submitResult?.tmpPath]) {
    if (!p) continue;
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }

  const failed =
    (exitCode != null && exitCode !== 0) ||
    /syntax error|script error|not found|execution error|failed|quitting!|usage:/i.test(
      out.slice(-2000),
    );

  if (failed) {
    const prev = failMap?.get(sig) || { n: 0, err: '', bin };
    failMap?.set(sig, {
      n: prev.n + 1,
      err: errTail || prev.err || `exit ${exitCode ?? '?'}`,
      bin: bin || prev.bin || '',
    });
    if (runState) {
      runState.fail += 1;
      runState.lastFailed = true;
      runState.lastError = errTail || `exit ${exitCode ?? '?'}`;
      runState.diagnosisAsked = false;
    }
  } else {
    failMap?.delete(sig);
    if (runState) {
      runState.ok += 1;
      runState.lastFailed = false;
      runState.lastError = '';
    }
  }

  ledger?.putBlob(out, tags.includes('install') ? 'install' : 'cmd');
  track('cmd_end', {
    actor: 'gex',
    cmd: line,
    exit: exitCode,
    duration_ms: Date.now() - t0,
    tags,
    auto: fmtAuto(auto),
  });
  ranCommands.push(line);

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

  // Escalation is COACHED here, not blocked by the gate: the advice lands in
  // the tool result the model reads the instant it fails, and it widens the
  // source each time the current one comes up dry. Generic to any domain.
  let failNote = '';
  if (failed) {
    const n = failMap?.get(sig)?.n || 1;
    const total = runState?.fail || n;
    const head = `\nFAIL #${n} for this command shape (bin=${bin || '?'}). Do NOT retry it, and do NOT merely reword it.`;
    if (total >= 3 && runState && !runState.gsearchTried) {
      failNote = `${head}\nESCALATE NOW → action=gsearch. ${total} failures means the answer is not reachable from this machine's own files. Give 3+ different phrasings in "angles" plus the official docs domain in "sites". Note: correct NAMES are not correct USAGE — if the identifiers are right and it still fails, you need a WORKING EXAMPLE of the calling idiom, not another grep of the same schema.`;
    } else if (total >= 2 && runState && !runState.discoverTried) {
      failNote = `${head}\nESCALATE NOW → action=discover with several INDEPENDENT probes (the underlying definition/data file, --help/man, live introspection). Stop guessing at names; go read them.`;
    } else {
      failNote = `${head}\nDiagnose the root cause, then either fix the form or widen your source: action=discover for local ground truth, action=gsearch when the machine itself does not have the answer.`;
    }
  }


  messages.push({
    role: 'user',
    content: `TOOL_RESULT ${tags.includes('install') ? 'install' : 'submit'} reason=${result.reason} exit=${exitCode ?? 'null'} ms=${Date.now() - t0} auto=${fmtAuto(auto)}\n$ ${line}\n--- OUTPUT (this command only) ---\n${out || '(no output)'}${failNote}\n\n${REJECT.afterTool}`,
  });
}

/**
 * Run jobs as real, visible fish background jobs — `begin;<cmd>;end > file &`
 * per job, then `wait`. The user sees exactly what typing that themselves
 * would show (including fish's own "Job N has ended" notices) — nothing
 * hidden about the mechanism. Only each job's OWN stdout/stderr is
 * redirected into a private temp file (same as a human piping to a
 * logfile) so gex can report structured per-job results; the trailing
 * exit-code echo lives inside that same redirect, never on screen.
 */
async function runParallelInPty(session, jobs, { gengar, steerQueue, auto, timeoutMs }) {
  const stamp = Date.now();
  const files = jobs.map((j, i) =>
    path.join(os.tmpdir(), `gex-par-${process.pid}-${i}-${stamp}.out`),
  );
  const markerBase = `___GEX_EXIT_${process.pid}_${stamp}`;
  const parts = jobs.map((j, i) => {
    const q = `'${files[i].replace(/'/g, `'\\''`)}'`;
    return `begin; ${j.cmd}; echo "${markerBase}_${i}:$status"; end > ${q} 2>&1 &`;
  });
  const line = `${parts.join(' ')} wait`;

  const mark = session.buffer.length;
  await session.submit(line);
  const result = await watchUntilPrompt(session, {
    mark,
    gengar,
    steerQueue,
    auto,
    timeoutMs,
  });

  return jobs.map((j, i) => {
    let out = '';
    try {
      out = fs.readFileSync(files[i], 'utf8');
    } catch {
      /* job never wrote — steer/timeout before it finished */
    }
    try {
      fs.unlinkSync(files[i]);
    } catch {
      /* ignore */
    }
    const m = out.match(new RegExp(`${markerBase}_${i}:(-?\\d+)\\s*$`));
    const code = m ? Number(m[1]) : result.reason === 'timeout' ? 124 : 1;
    const cleanOut = m ? out.slice(0, out.lastIndexOf(m[0])).replace(/\n$/, '') : out;
    return { id: j.id, cmd: j.cmd, code, out: cleanOut, ms: 0 };
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
    // A steer arriving mid-command must be ACKNOWLEDGED immediately and
    // loudly. Previously it silently aborted the watch while the command
    // kept running, so the user saw no confirmation and assumed it was
    // dropped — and the next command could be submitted into a busy PTY.
    if (steerQueue?.length) {
      process.stderr.write(
        `\n\x1b[48;2;255;122;24m\x1b[38;2;12;8;20m STEER RECEIVED \x1b[0m \x1b[38;2;255;180;84m${clip(
          steerQueue.map((x) => String(x)).join(' | '),
          90,
        )}\x1b[0m\n`,
      );
      gengar?.setState('awake', 'steer taken');
      return { reason: 'steer', exitHint: null };
    }
    if (session.exited) return { reason: 'exited', exitHint: session.exitCode };

    const len = session.buffer.length;
    if (len !== lastLen) {
      lastLen = len;
      lastGrowth = Date.now();
    }

    if (promptAfterMark(session, mark) && Date.now() - lastGrowth >= 450) {
      return {
        reason: auto.cancelled ? 'cancelled' : 'prompt',
        exitHint: auto.cancelled ? 130 : null,
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
  const base =
    first(
      a.command,
      a.install_cmd,
      a.text,
      Array.isArray(a.commands) ? a.commands[0] : '',
      Array.isArray(a.jobs) ? a.jobs[0]?.cmd : '',
    ) || '';
  // Script-body submissions materialize to `cat '<tmp>'; <bin> '<tmp>'`
  // before they run — mirror that shape here (any placeholder text
  // collapses under cmdSignature's quote-folding) so the pre-run fail-map
  // lookup lines up with what execLine actually records after materializing.
  const scriptBody = first(a.script, a.body, a.stdin, a.applescript);
  if (scriptBody && base) return `cat '…'; ${base} '…'`;
  return base;
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

/** Stable signature for a batch of jobs, order-independent. */
function batchSignature(jobs) {
  return `batch:${(jobs || [])
    .map((j) => cmdSignature(j.cmd))
    .sort()
    .join('|')}`.slice(0, 600);
}

/** Collapse string literals so tiny quote edits still match. */
function cmdSignature(line) {
  return String(line || '')
    .replace(/'(?:\\'|[^'])*'/g, "'…'")
    .replace(/"(?:\\"|[^"])*"/g, '"…"')
    .replace(/\$'[\s\S]*?'/g, "$'…'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function extractErrors(out) {
  return String(out || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) =>
      /error|failed|not found|syntax|denied|quitting|usage:|execution error/i.test(
        l,
      ),
    )
    .slice(-5)
    .join(' | ')
    .slice(0, 400);
}

/** Prefer real shell exit from the theme's own prompt marker (fish ✘ N). */
function inferExit(out, hint) {
  const text = String(out || '');
  const m1 = text.match(/✘\s*(\d+)/);
  if (m1) return Number(m1[1]);
  const m2 = text.match(/\bexit(?:ed| status| code)?[:\s]+(\d+)\b/i);
  if (m2) return Number(m2[1]);
  if (
    /syntax error|execution error|not found|command not found/i.test(
      text.slice(-2500),
    )
  ) {
    return hint != null && hint !== 0 ? hint : 1;
  }
  if (hint != null) return hint;
  return 0;
}

function normBin(s) {
  return String(s || '')
    .trim()
    .replace(/.*\//, '');
}

function fmtAuto(auto) {
  if (!auto) return 'n/a';
  return `y=${auto.answeredConfirm ? 1 : 0},cxl=${auto.cancelled ? 1 : 0}`;
}

function drainSteers(q, messages, session, track, gengar) {
  if (!q?.length) return;
  const lines = q
    .splice(0, q.length)
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (!lines.length) return;
  gengar?.setState('awake', 'steer');
  for (const line of lines) track('steer', { actor: 'user', text: line });
  messages.push({
    role: 'user',
    content: `STEER (user override — obey immediately)\n${lines.join('\n')}\nIf they say stuck/stop/wrong: change approach NOW. Do not repeat the last failing command.\n--- SCREEN ---\n${session.screenText(8000)}`,
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

function firstLine(s) {
  return String(s || '').split('\n')[0].trim();
}

/** Clean output produced by THIS command only (buffer since its mark). */
function deltaText(session, mark, n = 14000) {
  const text = stripAnsi(String(session.buffer.slice(mark)))
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length)
    .join('\n')
    .trim();
  return text.length > n ? `…(trimmed)…\n${text.slice(-n)}` : text;
}

/**
 * Keep the conversation focused. Old TOOL_RESULT bodies are the single
 * biggest source of context noise — and re-reading stale failures is what
 * made the model repeat them. Keep the newest few verbatim, reduce the rest
 * to their header line.
 */
function compactMessages(messages, keepVerbatim = 3) {
  const idxs = [];
  for (let i = 2; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && /^TOOL_RESULT /.test(String(m.content || ''))) {
      idxs.push(i);
    }
  }
  for (const i of idxs.slice(0, Math.max(0, idxs.length - keepVerbatim))) {
    const content = String(messages[i].content || '');
    if (content.length <= 400) continue;
    messages[i] = {
      role: 'user',
      content: `${firstLine(content)}\n(earlier output trimmed — superseded by newer results)`,
    };
  }
}

/**
 * Write body to a temp file; return { line: "cat <file>; <runner> <file>", tmpPath }.
 * `cat` first so the real script content is visible before it runs — a temp
 * file is an implementation detail, its contents must not be hidden.
 * No `; rm -f` chained onto the line — that would make the shell's real
 * exit status reflect `rm`, not the script, silently defeating fail
 * detection. Caller (execLine) deletes tmpPath from Node once the run is
 * over, invisibly — the user's terminal only ever shows the real command.
 */
function materializeScript(runner, body) {
  let text = String(body || '');
  if (!text.includes('\n') && /\\n/.test(text)) {
    text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }
  if (!text.trim()) return { line: '', tmpPath: '', bin: '' };
  const base =
    String(runner || 'bash')
      .trim()
      .split(/\s+/)[0] || 'bash';
  const bin = base.replace(/.*\//, '');
  const ext = /osascript/i.test(bin)
    ? '.applescript'
    : /python/i.test(bin)
      ? '.py'
      : /node|bun/i.test(bin)
        ? '.js'
        : /ruby/i.test(bin)
          ? '.rb'
          : /perl/i.test(bin)
            ? '.pl'
            : '.sh';
  const tmp = path.join(os.tmpdir(), `gex-${process.pid}-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
  const q = `'${tmp.replace(/'/g, `'\\''`)}'`;
  return { line: `cat ${q}; ${bin} ${q}`, tmpPath: tmp, bin };
}
