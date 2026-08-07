/**
 * Dynamic run detection — NOT a tool allowlist.
 * A command is "still running" if we haven't seen a NEW shell prompt
 * after the submit, or output is still flowing.
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
  // OS fingerprint without root usually dies — drop -O unless sudo/root requested
  if (/\bnmap\b/i.test(c) && /\s-O\b/.test(c) && !/\bsudo\b/i.test(c) && !/\broot\b/i.test(t)) {
    c = c.replace(/\s-O\b/g, ' ');
    if (!/\s-sV\b/.test(c)) c = c.replace(/\bnmap\b/, 'nmap -sV');
  }
  return c;
}

/** Shell prompt heuristics (fish/zsh/bash/starship/gsh). */
export function isShellPrompt(text) {
  const tail = String(text || '').slice(-600);
  // Prefer last non-empty lines
  const lines = tail.split('\n').filter((l) => l.trim().length);
  const last = lines.slice(-3).join('\n');
  return (
    /╰─\s*gsh\/\d+/i.test(last) ||
    /gsh\/\d+\s*$/m.test(last) ||
    /[❯›]\s*$/m.test(last) ||
    /\$\s*$/m.test(last) ||
    /%\s*$/m.test(last) ||
    /#\s*$/m.test(last) ||
    /fish\s*$/m.test(last)
  );
}

/**
 * True if the buffer grew past mark and then shows a prompt
 * that wasn't only the pre-command leftover.
 */
export function promptAfterMark(session, mark) {
  if (session.exited) return true;
  if (session.buffer.length <= mark + 2) return false;
  // New content since mark
  const delta = session.buffer.slice(mark);
  const stripped = delta
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  // Need real output or at least a newline then prompt
  if (stripped.trim().length < 1) return false;
  return isShellPrompt(session.screenText(800));
}

export { classifyTail } from './interactive.js';
