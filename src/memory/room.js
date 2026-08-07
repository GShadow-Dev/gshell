import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function gexHome() {
  return path.join(os.homedir(), '.cache', 'gex');
}

export function roomDir(roomId) {
  return path.join(gexHome(), 'rooms', roomId);
}

/**
 * Stable-ish room id for this terminal tab/lifetime.
 * Parent pid comes from fish wrapper (GEX_PARENT_PID).
 */
export function resolveRoomId(env = process.env) {
  const tty = tryTty();
  const parent = env.GEX_PARENT_PID || String(process.ppid || '0');
  const host = os.hostname();
  const raw = `${host}|${tty}|${parent}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function tryTty() {
  try {
    return execSync('tty', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return `pid-${process.pid}`;
  }
}

export function ensureRoom(roomId) {
  const dir = roomDir(roomId);
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'summaries'), { recursive: true });
  return dir;
}

export function roomsRoot() {
  return path.join(gexHome(), 'rooms');
}
