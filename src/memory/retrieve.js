import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roomDir, gexHome } from './room.js';

/**
 * Build a budgeted memory pack for the Mind at summon time.
 */
export function buildSummonPack(ledger, task, { maxChars = 3500 } = {}) {
  const parts = [];
  const summary = ledger.latestSummary();
  const events = ledger.tail(120);
  const scribe = loadScribeRecent(40);

  parts.push(`room=${ledger.roomId} session=${ledger.sessionId}`);

  if (summary) {
    parts.push('## Last gex session');
    parts.push(summarizeBlock(summary));
  }

  const userFromLedger = events
    .filter((e) => e.kind === 'user_cmd' || (e.kind === 'cmd_end' && e.actor === 'user'))
    .slice(-8);

  const userCmds = [...scribe, ...userFromLedger].slice(-16);
  if (userCmds.length) {
    parts.push('## Recent user commands (between summons)');
    for (const e of userCmds) {
      parts.push(`- ${fmtTime(e.ts)} exit=${e.exit ?? '?'} ${e.cmd || ''}`);
    }
  }

  const gexCmds = events
    .filter((e) => e.kind === 'cmd_end' && e.actor === 'gex')
    .slice(-15);
  if (gexCmds.length) {
    parts.push('## Recent gex commands');
    for (const e of gexCmds) {
      parts.push(`- ${fmtTime(e.ts)} exit=${e.exit ?? '?'} ${e.cmd || ''}`);
    }
  }

  const steers = events.filter((e) => e.kind === 'steer').slice(-8);
  if (steers.length) {
    parts.push('## Steers');
    for (const e of steers) parts.push(`- ${e.text || ''}`);
  }

  const replies = events.filter((e) => e.kind === 'gex_reply').slice(-5);
  if (replies.length) {
    parts.push('## Prior gex replies (truncated)');
    for (const e of replies) parts.push(`- ${clip(e.text || '', 280)}`);
  }

  const hits = searchLedger(ledger, task, 8);
  if (hits.length) {
    parts.push('## Memory hits for task');
    for (const h of hits) parts.push(`- ${h}`);
  }

  const caveats = events
    .filter((e) => e.kind === 'caveat' || e.kind === 'error_sig')
    .slice(-10);
  if (caveats.length) {
    parts.push('## Caveats / errors');
    for (const e of caveats) parts.push(`- ${e.text || e.msg || ''}`);
  }

  let pack = parts.join('\n');
  if (pack.length > maxChars) pack = `${pack.slice(0, maxChars)}\n…[pack truncated]`;
  return pack;
}

function loadScribeRecent(n) {
  const dir = path.join(gexHome(), 'scribe');
  if (!fs.existsSync(dir)) return [];
  const all = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.ndjson')) continue;
    try {
      const lines = fs
        .readFileSync(path.join(dir, name), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean);
      for (const line of lines.slice(-n)) {
        try {
          const e = JSON.parse(line);
          if (e.cmd_b64 && !e.cmd) {
            e.cmd = Buffer.from(e.cmd_b64, 'base64').toString('utf8');
          }
          if (e.cwd_b64 && !e.cwd) {
            e.cwd = Buffer.from(e.cwd_b64, 'base64').toString('utf8');
          }
          all.push(e);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return all.slice(-n);
}

function searchLedger(ledger, task, limit) {
  const q = String(task || '')
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  if (!q.length) return [];
  const hits = [];
  for (const e of ledger.tail(500).reverse()) {
    const blob = JSON.stringify(e).toLowerCase();
    if (q.some((w) => blob.includes(w))) {
      if (e.kind === 'cmd_end') hits.push(`${e.actor}: ${e.cmd} → ${e.exit}`);
      else if (e.kind === 'gex_reply') hits.push(`reply: ${clip(e.text, 160)}`);
      else if (e.kind === 'session_summary') hits.push(`summary: ${e.title}`);
      else if (e.text) hits.push(`${e.kind}: ${clip(e.text, 160)}`);
      if (hits.length >= limit) break;
    }
  }
  // also search scribe
  for (const e of loadScribeRecent(80).reverse()) {
    const blob = `${e.cmd}`.toLowerCase();
    if (q.some((w) => blob.includes(w))) {
      hits.push(`user: ${e.cmd} → ${e.exit}`);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

export function searchBlobs(ledger, query, limit = 3) {
  const dir = path.join(roomDir(ledger.roomId), 'blobs');
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.txt')) continue;
    const t = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!re.test(t)) continue;
    const lines = t.split('\n').filter((l) => re.test(l)).slice(0, 6);
    out.push({ ref: name.replace(/\.txt$/, ''), lines });
    if (out.length >= limit) break;
  }
  return out;
}

function summarizeBlock(s) {
  const lines = [];
  if (s.title) lines.push(s.title);
  if (s.outcome) lines.push(s.outcome);
  if (s.commands?.length) lines.push(`cmds: ${s.commands.slice(0, 12).join(' · ')}`);
  if (s.caveats?.length) lines.push(`caveats: ${s.caveats.slice(0, 6).join(' · ')}`);
  if (s.packages?.length) lines.push(`packages: ${s.packages.slice(0, 20).join(', ')}`);
  return lines.join('\n');
}

function fmtTime(ts) {
  try {
    return new Date(ts).toISOString().slice(11, 19);
  } catch {
    return '?';
  }
}

function clip(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// silence unused
void os;
