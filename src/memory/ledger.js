import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureRoom, roomDir, roomsRoot } from './room.js';
export class Ledger {
  constructor(roomId) {
    this.roomId = roomId;
    this.dir = ensureRoom(roomId);
    this.path = path.join(this.dir, 'ledger.ndjson');
    this.seq = this._lastSeq();
    this.sessionId = crypto.randomBytes(6).toString('hex');
  }

  _lastSeq() {
    if (!fs.existsSync(this.path)) return 0;
    try {
      const tail = fs.readFileSync(this.path, 'utf8').trim().split('\n').slice(-5);
      let max = 0;
      for (const line of tail) {
        const j = JSON.parse(line);
        if (j.seq > max) max = j.seq;
      }
      return max;
    } catch {
      return 0;
    }
  }

  append(kind, fields = {}) {
    this.seq += 1;
    const ev = {
      ts: Date.now(),
      seq: this.seq,
      session: this.sessionId,
      kind,
      ...fields,
    };
    fs.appendFileSync(this.path, `${JSON.stringify(ev)}\n`);
    return ev;
  }

  /** Store raw text blob; returns ref */
  putBlob(text, tag = 'out') {
    const body = String(text ?? '');
    const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
    const ref = `${tag}-${hash}`;
    const fp = path.join(this.dir, 'blobs', `${ref}.txt`);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, body);
    return ref;
  }

  readBlob(ref, { max = 12000, grep = null } = {}) {
    const fp = path.join(this.dir, 'blobs', `${ref}.txt`);
    if (!fs.existsSync(fp)) return null;
    let t = fs.readFileSync(fp, 'utf8');
    if (grep) {
      const re = new RegExp(grep, 'i');
      t = t
        .split('\n')
        .filter((l) => re.test(l))
        .join('\n');
    }
    if (t.length > max) t = t.slice(-max);
    return t;
  }

  /** Recent events newest-last */
  tail(n = 80) {
    if (!fs.existsSync(this.path)) return [];
    const lines = fs.readFileSync(this.path, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  /** Full scan (careful) */
  all() {
    return this.tail(100000);
  }

  writeSummary(summary) {
    const fp = path.join(this.dir, 'summaries', `${this.sessionId}.json`);
    fs.writeFileSync(fp, JSON.stringify(summary, null, 2));
    this.append('session_summary', {
      actor: 'gex',
      summary_ref: this.sessionId,
      title: summary.title || '',
      tags: summary.tags || [],
    });
    // also pointer for quick load
    fs.writeFileSync(
      path.join(this.dir, 'summaries', 'latest.json'),
      JSON.stringify(summary, null, 2),
    );
    return fp;
  }

  latestSummary() {
    const fp = path.join(this.dir, 'summaries', 'latest.json');
    if (!fs.existsSync(fp)) return null;
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
      return null;
    }
  }
}

export function listRoomIds() {
  const base = roomsRoot();
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter((n) => {
    try {
      return fs.statSync(path.join(base, n)).isDirectory();
    } catch {
      return false;
    }
  });
}
