/**
 * Cheap local distill — no extra LLM call required.
 * Turns a gex session into a graph-friendly summary node.
 */
export function distillSession({ task, events, finalMessage }) {
  const cmds = [];
  const caveats = [];
  const packages = [];
  const errors = [];
  let durationMs = 0;
  let start = null;
  let end = null;

  for (const e of events) {
    if (!start || e.ts < start) start = e.ts;
    if (!end || e.ts > end) end = e.ts;
    if (e.kind === 'cmd_end' && e.actor === 'gex' && e.cmd) {
      cmds.push(e.cmd);
      if (e.exit && e.exit !== 0) errors.push(`${e.cmd} → ${e.exit}`);
    }
    if (e.kind === 'caveat' && e.text) caveats.push(e.text);
    if (e.kind === 'gex_reply' && e.text) {
      // harvest package names from brew-style replies
      const m = e.text.match(/(?:upgraded|Upgraded)\s+\d+[^\n]*:\s*([^\n]+)/i);
      if (m) {
        for (const p of m[1].split(/[,,]/).map((s) => s.trim()).filter(Boolean)) {
          packages.push(p.replace(/\.$/, ''));
        }
      }
    }
    if (e.kind === 'confirm') {
      caveats.push(`confirmed: ${e.cmd || e.text || 'yn'}`);
    }
  }

  // Also parse final message for package lists
  if (finalMessage) {
    const pkgs = finalMessage.match(/\b([a-z0-9][\w.+-]{1,40})(?:\s*,\s*|\s+and\s+)/gi);
    void pkgs;
    const brewList = finalMessage.match(/Upgraded \d+ packages?:\s*([^\n]+)/i);
    if (brewList) {
      for (const p of brewList[1].split(/,|and/).map((s) => s.trim()).filter((s) => s.length > 1)) {
        if (!packages.includes(p)) packages.push(p);
      }
    }
    // caveats lines
    for (const line of String(finalMessage).split('\n')) {
      if (/shadow|caveat|warning|require|not trusted/i.test(line)) {
        caveats.push(line.trim());
      }
    }
  }

  durationMs = start && end ? end - start : 0;

  return {
    title: clip(task, 120),
    outcome: clip(finalMessage || '', 600),
    commands: uniq(cmds).slice(0, 40),
    packages: uniq(packages).slice(0, 60),
    caveats: uniq(caveats).slice(0, 20),
    errors: uniq(errors).slice(0, 20),
    duration_ms: durationMs,
    tags: inferTags(task, cmds),
    at: new Date().toISOString(),
  };
}

function inferTags(task, cmds) {
  const t = `${task} ${cmds.join(' ')}`.toLowerCase();
  const tags = [];
  if (/brew/.test(t)) tags.push('brew');
  if (/git/.test(t)) tags.push('git');
  if (/npm|pnpm|yarn|node|next/.test(t)) tags.push('node');
  if (/cargo|rust/.test(t)) tags.push('rust');
  if (/stat|cpu|mem|disk|load/.test(t)) tags.push('sys');
  return tags;
}

function uniq(a) {
  return [...new Set(a.filter(Boolean))];
}

function clip(s, n) {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
