/**
 * Dynamic run detection — NOT a tool allowlist.
 * Done = NEW content after submit mark AND that new content ends with a shell prompt.
 */

export function riskForCommand(cmd) {
  const c = String(cmd || '');
  if (/\bsudo\b|rm\s+-rf\s+\/|git\s+push\s+.*--force|curl\s+.*\|\s*(ba)?sh/i.test(c)) {
    return 'red';
  }
  if (/\bbrew\s+|npm\s+i|pnpm\s+i|git\s+push|nmap\b|masscan\b/i.test(c)) {
    return 'amber';
  }
  return 'green';
}

export function rewriteCommand(cmd, task) {
  let c = String(cmd || '').trim();
  const t = String(task || '');

  if (/\bbrew\s+upgrade\b/i.test(c) && !/HOMEBREW_NO_ENV_HINTS/.test(c)) {
    c = `env HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_ANALYTICS=1 ${c}`;
  }
  if (/\bnpx\s+/.test(c) && !/\bnpx\s+--yes\b/.test(c) && !/\bnpx\s+-y\b/.test(c)) {
    c = c.replace(/\bnpx\b/, 'npx --yes');
  }
  if (/\bnmap\b/i.test(c) && /\s-O\b/.test(c) && !/\bsudo\b/i.test(c) && !/\broot\b/i.test(t)) {
    c = c.replace(/\s-O\b/g, ' ');
    if (!/\s-sV\b/.test(c)) c = c.replace(/\bnmap\b/, 'nmap -sV');
  }
  // Keep long nmap jobs chatty so humans + heartbeat have signal
  if (/\bnmap\b/i.test(c) && !/--stats-every/.test(c)) {
    c = c.replace(/\bnmap\b/, 'nmap --stats-every 5s');
  }
  return c;
}

function stripAnsi(s) {
  return String(s || '')
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

/** Shell prompt heuristics on a text chunk (usually the post-command delta). */
export function isShellPrompt(text) {
  const tail = stripAnsi(text).slice(-800);
  const lines = tail.split('\n').filter((l) => l.trim().length);
  if (!lines.length) return false;
  // Only the LAST line can be the live prompt
  const last = lines[lines.length - 1];
  return (
    /╰─\s*gsh\/\d+/i.test(last) ||
    /gsh\/\d+\s*$/i.test(last) ||
    /[❯›]\s*$/.test(last) ||
    /\$\s*$/.test(last) ||
    /%\s*$/.test(last) ||
    /#\s*$/.test(last)
  );
}

/**
 * True when buffer grew past mark and the NEW slice ends with a prompt.
 */
export function promptAfterMark(session, mark) {
  if (session.exited) return true;
  if (session.buffer.length <= mark + 1) return false;
  const delta = stripAnsi(session.buffer.slice(mark));
  // Must have more than just the echoed command line
  if (delta.trim().length < 2) return false;
  return isShellPrompt(delta);
}

export { classifyTail } from './interactive.js';
