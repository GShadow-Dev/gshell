import { sleep } from '../keys.js';

/**
 * Watches PTY output as it arrives and reacts in milliseconds — no LLM wait.
 *
 * - confirm_yn → y + enter (sprite casting)
 * - password → needs_you
 * - install_progress + cancel intent in task → ctrl-c
 */
export class InteractiveAutopilot {
  constructor(session, { gengar, track, task = '', onEvent } = {}) {
    this.session = session;
    this.gengar = gengar;
    this.track = track || (() => {});
    this.task = String(task || '');
    this.onEvent = onEvent || (() => {});
    this.enabled = true;
    this.lastFire = 0;
    this.lastKind = '';
    this.answeredConfirm = false;
    this.cancelled = false;
    this.cancelIntent = /\b(cancel|abort|kill|stop|interrupt|ctrl-?c|abrupt)/i.test(
      this.task,
    );
    this.cleanupIntent = /\b(delete|remove|clean|rm\s+-rf|cleanup)/i.test(this.task);
    this._unsub = null;
    this.log = [];
  }

  start() {
    this._unsub = this.session.onOutput((_display, full) => {
      if (!this.enabled) return;
      this._react(full);
    });
  }

  stop() {
    this.enabled = false;
    if (this._unsub) this._unsub();
    this._unsub = null;
  }

  _react(screen) {
    const now = Date.now();
    const tail = strip(screen).slice(-1200);
    const kind = classifyTail(tail);
    if (!kind) return;
    if (kind === this.lastKind && now - this.lastFire < 800) return;

    if (kind === 'password') {
      this.lastKind = kind;
      this.lastFire = now;
      this.gengar?.setState('needs_you', 'password');
      this.track('caveat', { text: 'password prompt' });
      this.onEvent({ type: 'password' });
      this.log.push({ t: now, kind });
      return;
    }

    if (kind === 'confirm_yn' && !this.answeredConfirm) {
      this.answeredConfirm = true;
      this.lastKind = kind;
      this.lastFire = now;
      this.gengar?.act('y');
      this.track('confirm', { actor: 'gex', text: 'y', auto: true, fast: true });
      try {
        this.session.term.write('y\r');
      } catch {
        /* ignore */
      }
      this.onEvent({ type: 'confirm_yn', sent: 'y' });
      this.log.push({ t: now, kind, sent: 'y' });
      return;
    }

    if (this.cancelIntent && !this.cancelled && kind === 'install_progress') {
      this.cancelled = true;
      this.lastKind = kind;
      this.lastFire = now;
      this.gengar?.act('ctrl-c');
      this.track('cancel', {
        actor: 'gex',
        auto: true,
        reason: 'task cancel mid-install',
      });
      queueMicrotask(async () => {
        await sleep(280);
        try {
          this.session.term.write('\x03');
        } catch {
          /* ignore */
        }
        await sleep(180);
        try {
          this.session.term.write('\x03');
        } catch {
          /* ignore */
        }
      });
      this.onEvent({ type: 'cancel', sent: 'ctrl-c' });
      this.log.push({ t: now, kind, sent: 'ctrl-c' });
    }
  }
}

export function classifyTail(tail) {
  const t = tail;
  if (/(password:|passphrase:|sudo password)/i.test(t)) return 'password';

  if (
    /ok to proceed\?\s*\(y\)/i.test(t) ||
    /\(y\)\s*$/m.test(t) ||
    /\[y\/n\]/i.test(t) ||
    /\[Y\/n\]/i.test(t) ||
    /\(y\/N\)/i.test(t) ||
    /\(yes\/no\)/i.test(t) ||
    /do you want to proceed/i.test(t) ||
    /are you sure\?/i.test(t) ||
    /continue\?/i.test(t) ||
    /overwrite\?/i.test(t)
  ) {
    return 'confirm_yn';
  }

  if (
    /installing dependencies/i.test(t) ||
    /installing devDependencies/i.test(t) ||
    /Downloading.*bottle/i.test(t) ||
    /Pouring .*\.bottle/i.test(t) ||
    /Fetching packages/i.test(t) ||
    /Resolving dependencies/i.test(t) ||
    /Creating a new Next\.js app/i.test(t) ||
    /added \d+ packages/i.test(t)
  ) {
    return 'install_progress';
  }

  return null;
}

function strip(s) {
  return String(s)
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}
