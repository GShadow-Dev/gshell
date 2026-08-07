import { sleep } from '../keys.js';
import { snapSystem, snapUser } from '../prompts.js';

const API = 'https://api.deepseek.com/chat/completions';

/**
 * Reactive PTY layer:
 * 1) Detect prompts on the byte stream (local, instant)
 * 2) Ask the model a TINY fast decision (not the main agent loop)
 * 3) Type the answer immediately + sprite casting
 *
 * AI decides. Detection is fast. Decision call is minimal context.
 */
export class InteractiveAutopilot {
  constructor(
    session,
    { gengar, track, task = '', apiKey = '', onEvent } = {},
  ) {
    this.session = session;
    this.gengar = gengar;
    this.track = track || (() => {});
    this.task = String(task || '');
    this.apiKey = apiKey || process.env.DEEPSEEK_API_KEY || '';
    this.onEvent = onEvent || (() => {});
    this.enabled = true;
    this.busy = false;
    this.lastFire = 0;
    this.lastKind = '';
    this.answeredConfirm = false;
    this.cancelled = false;
    this.cancelIntent = /\b(cancel|abort|kill|stop|interrupt|ctrl-?c|abrupt|pretend)\b/i.test(
      this.task,
    );
    this.cleanupIntent = /\b(delete|remove|clean|rm\s+-rf|cleanup)\b/i.test(this.task);
    this._unsub = null;
    this.log = [];
    this._pending = null;
  }

  start() {
    this._unsub = this.session.onOutput((_display, full) => {
      if (!this.enabled || this.busy) return;
      this._onScreen(full);
    });
  }

  stop() {
    this.enabled = false;
    if (this._unsub) this._unsub();
    this._unsub = null;
  }

  _onScreen(screen) {
    const now = Date.now();
    const tail = strip(screen).slice(-1800);
    const kind = classifyTail(tail);
    if (!kind) return;
    if (kind === 'install_progress') {
      this._maybeCancel(now, kind);
      return;
    }
    if (kind === this.lastKind && now - this.lastFire < 900) return;
    if (kind === 'password') {
      this.lastKind = kind;
      this.lastFire = now;
      this.gengar?.setState('needs_you', 'password');
      this.track('caveat', { text: 'password — user must type' });
      this.onEvent({ type: 'password' });
      this.log.push({ t: now, kind });
      return;
    }
    // confirm / menu / typed_challenge → fast AI decide
    this._decideAndSend(kind, tail, now);
  }

  async _decideAndSend(kind, tail, now) {
    if (this.busy) return;
    this.busy = true;
    this.lastKind = kind;
    this.lastFire = now;
    this.gengar?.setState('thinking', 'snap decide');

    try {
      const answer = await fastDecide({
        apiKey: this.apiKey,
        task: this.task,
        kind,
        promptTail: tail,
      });

      if (!answer || answer === 'WAIT' || answer === 'NEED_USER') {
        this.gengar?.setState('needs_you', answer || 'input');
        this.track('caveat', { text: `prompt ${kind} → ${answer || 'empty'}` });
        this.onEvent({ type: kind, sent: null, answer });
        this.log.push({ t: Date.now(), kind, sent: null, answer });
        return;
      }

      if (kind === 'confirm_yn') this.answeredConfirm = true;

      this.gengar?.act(clip(answer, 20));
      this.track('confirm', {
        actor: 'gex',
        text: answer,
        auto: true,
        fast: true,
        ai: true,
        kind,
      });

      // Send exactly what the model chose
      try {
        this.session.term.write(`${answer}\r`);
      } catch {
        /* ignore */
      }

      this.onEvent({ type: kind, sent: answer });
      this.log.push({ t: Date.now(), kind, sent: answer });

      // allow later prompts
      if (kind === 'confirm_yn') {
        setTimeout(() => {
          this.answeredConfirm = false;
        }, 3500);
      }
    } catch (err) {
      this.gengar?.setState('needs_you', 'decide fail');
      this.track('caveat', { text: `fastDecide error: ${err.message}` });
    } finally {
      this.busy = false;
    }
  }

  _maybeCancel(now, kind) {
    if (!this.cancelIntent || this.cancelled) return;
    // Prefer after a confirm if we saw one; else allow after progress alone
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
      await sleep(250);
      try {
        this.session.term.write('\x03');
      } catch {
        /* ignore */
      }
      await sleep(150);
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

/**
 * Tiny, low-latency completion. Returns a single reply string to type.
 */
export async function fastDecide({ apiKey, task, kind, promptTail }) {
  if (!apiKey) {
    // deterministic micro-fallback if no key mid-flight
    return fallbackDecide(kind, promptTail, task);
  }

  const system = snapSystem();
  const user = snapUser({ task, kind, promptTail });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);

  try {
    const res = await fetch(API, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0,
        max_tokens: 24,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) return fallbackDecide(kind, promptTail, task);
    const data = await res.json();
    let text = data.choices?.[0]?.message?.content?.trim() || '';
    // sanitize: first line, strip quotes/fences
    text = text.split('\n')[0].trim();
    text = text.replace(/^["'`]+|["'`]+$/g, '');
    text = text.replace(/^(answer|type|press|send)\s*[:=]\s*/i, '');
    if (!text || text.length > 80) return fallbackDecide(kind, promptTail, task);
    if (/^need_user$/i.test(text)) return 'NEED_USER';
    return text;
  } catch {
    return fallbackDecide(kind, promptTail, task);
  } finally {
    clearTimeout(timer);
  }
}

/** Last-resort local heuristics if the snap call fails/times out. */
export function fallbackDecide(kind, tail, task) {
  const t = String(task || '').toLowerCase();
  const wantNo = /\b(say no|choose no|answer n\b|don't|dont|decline|reject)\b/.test(t);
  const wantYes =
    /\b(say yes|proceed|confirm|accept|install|upgrade|create|update)\b/.test(t) ||
    /\b(cancel|abort).*(install|loading|npx|brew)/.test(t);

  if (kind === 'confirm_yn') {
    if (wantNo) return 'n';
    if (wantYes) return 'y';
    if (/\(y\/N\)|\[y\/N\]/.test(tail)) return 'n';
    return 'y';
  }

  if (kind === 'typed_challenge') {
    const tok = extractChallengeToken(tail);
    if (tok && !wantNo) return tok;
    return 'NEED_USER';
  }

  if (kind === 'menu') {
    const num = t.match(/\b(?:choose|pick|select|option)\s*(\d{1,2})\b/);
    if (num) return num[1];
    const opts = [];
    for (const line of String(tail).split('\n')) {
      const m = line.match(/^\s*(?:\()?(\d{1,2})(?:\)|\.)\s+(.+)/);
      if (m) opts.push({ n: m[1], label: m[2].toLowerCase() });
    }
    if (/\btypescript|\bts\b/.test(t)) {
      const hit = opts.find((o) => /typescript|\bts\b/.test(o.label));
      if (hit) return hit.n;
    }
    if (opts[0]) return opts[0].n;
  }

  return 'NEED_USER';
}

export function extractChallengeToken(tail) {
  const patterns = [
    /type\s+["'`]([^"'`]+)["'`]\s+to\s+confirm/i,
    /enter\s+["'`]([^"'`]+)["'`]\s+to\s+confirm/i,
    /type\s+["'`]([^"'`]+)["'`]\s+to\s+delete/i,
    /please\s+type\s+["'`]([^"'`]+)["'`]/i,
    /confirm\s+by\s+typing\s+["'`]([^"'`]+)["'`]/i,
    /enter\s+the\s+following(?:\s+to\s+confirm)?\s*:\s*([A-Za-z0-9._*-]+)/i,
    /type\s+the\s+word\s+["'`]?([A-Za-z0-9._-]+)["'`]?/i,
    /\btype\s+([A-Z][A-Z0-9_-]{2,})\s+to\s+(?:confirm|delete|continue)/,
  ];
  for (const re of patterns) {
    const m = String(tail).match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function classifyTail(tail) {
  const t = tail;
  if (/(password:|passphrase:|sudo password)/i.test(t)) return 'password';

  if (
    /type\s+['"`][^'"`]+['"`]\s+to\s+confirm/i.test(t) ||
    /enter\s+['"`][^'"`]+['"`]\s+to\s+confirm/i.test(t) ||
    /type\s+['"`][^'"`]+['"`]\s+to\s+delete/i.test(t) ||
    /confirm\s+by\s+typing/i.test(t) ||
    /please\s+type\s+['"`]/i.test(t) ||
    /type\s+the\s+word\b/i.test(t) ||
    /enter\s+the\s+following\s+to\s+confirm/i.test(t) ||
    /\btype\s+[A-Z][A-Z0-9_-]{2,}\s+to\s+(?:confirm|delete)/.test(t) ||
    /re-?type\s+(?:the\s+)?(?:package\s+)?name/i.test(t)
  ) {
    return 'typed_challenge';
  }

  if (
    /ok to proceed\?\s*\(y\)/i.test(t) ||
    /\(y\)\s*$/m.test(t) ||
    /\[y\/n\]/i.test(t) ||
    /\[Y\/n\]/i.test(t) ||
    /\[y\/N\]/i.test(t) ||
    /\(y\/N\)/i.test(t) ||
    /\(Y\/n\)/i.test(t) ||
    /\(yes\/no\)/i.test(t) ||
    /do you want to proceed/i.test(t) ||
    /are you sure\?/i.test(t) ||
    /continue\?/i.test(t) ||
    /overwrite\?/i.test(t)
  ) {
    return 'confirm_yn';
  }

  const nums = t.match(/^\s*(?:❯\s*)?(?:\()?(\d{1,2})(?:\)|\.)\s+\S+/gm);
  if (nums && nums.length >= 2) return 'menu';

  if (/typescript\?/i.test(t) && /\byes\b/i.test(t) && /\bno\b/i.test(t)) {
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

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
