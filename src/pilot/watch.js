const LONG_JOB_RE =
  /\b(brew\s+upgrade|brew\s+install|npm\s+i(?:nstall)?|pnpm\s+i(?:nstall)?|yarn\s+add|cargo\s+build|cargo\s+install|docker\s+pull|docker\s+compose|mise\s+install|pip\s+install|npx\s+create-|create-next-app)\b/i;

const CONFIRM_RE =
  /(do you want to proceed|\[y\/n\]|\[Y\/n\]|\(y\/N\)|\(yes\/no\)|continue\?|overwrite\?|are you sure)/i;

const PASSWORD_RE = /(password:|passphrase:|sudo password)/i;

export function isLongJob(cmd) {
  return LONG_JOB_RE.test(String(cmd || ''));
}

export function detectPrompt(screenText) {
  const t = String(screenText || '');
  const tail = t.slice(-800);
  if (PASSWORD_RE.test(tail)) return { type: 'password', tier: 'red' };
  if (CONFIRM_RE.test(tail)) {
    // brew upgrade after explicit update task → green-ish amber
    return { type: 'confirm_yn', tier: 'green' };
  }
  return null;
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

/** Prefer noninteractive brew when task is clearly an upgrade. */
export function rewriteCommand(cmd, task) {
  let c = String(cmd || '');
  if (/\bbrew\s+upgrade\b/i.test(c) && !/HOMEBREW_NO_ENV_HINTS/.test(c)) {
    c = `env HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_ANALYTICS=1 ${c}`;
  }
  // If task says update/upgrade and brew asks nothing else
  void task;
  return c;
}
