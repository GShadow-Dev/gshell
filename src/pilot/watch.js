const LONG_JOB_RE =
  /\b(brew\s+upgrade|brew\s+install|npm\s+i(?:nstall)?|pnpm\s+i(?:nstall)?|yarn\s+(add|install)|cargo\s+build|cargo\s+install|docker\s+pull|docker\s+compose|mise\s+install|pip\s+install|npx\s+|create-next-app|npm\s+create)\b/i;

export function isLongJob(cmd) {
  return LONG_JOB_RE.test(String(cmd || ''));
}

export function riskForCommand(cmd) {
  const c = String(cmd || '');
  if (/\bsudo\b|rm\s+-rf\s+\/|git\s+push\s+.*--force|curl\s+.*\|\s*(ba)?sh/i.test(c)) {
    return 'red';
  }
  if (/\bbrew\s+upgrade\b|\bbrew\s+install\b|npm\s+i|pnpm\s+i|git\s+push|cask\b/i.test(c)) {
    return 'amber';
  }
  return 'green';
}

/** Prefer noninteractive flags when we can. */
export function rewriteCommand(cmd, task) {
  let c = String(cmd || '').trim();
  const t = String(task || '');

  if (/\bbrew\s+upgrade\b/i.test(c) && !/HOMEBREW_NO_ENV_HINTS/.test(c)) {
    c = `env HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_ANALYTICS=1 ${c}`;
  }

  // npx create-next-app: force --yes on npx and full flags if bare
  if (/\bnpx\s+/.test(c) && !/\bnpx\s+--yes\b/.test(c) && !/\bnpx\s+-y\b/.test(c)) {
    c = c.replace(/\bnpx\b/, 'npx --yes');
  }

  // If they said create-next-app without flags, leave mind's command but ensure yes
  if (/create-next-app/i.test(c) && !/--ts|--js/.test(c)) {
    // mind should add flags; don't hard-rewrite path/name
  }

  // Cancel tasks: still launch, interactive layer handles SIGINT
  void t;
  return c;
}

// re-export classify for agent convenience
export { classifyTail } from './interactive.js';
