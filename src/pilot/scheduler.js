import { spawn } from 'node:child_process';
import { sleep } from '../keys.js';

export async function runParallel(
  jobs,
  {
    concurrency = 2,
    cwd = process.cwd(),
    shell = process.env.SHELL || '/bin/bash',
    onUpdate,
    timeoutMs = 900_000,
  } = {},
) {
  const pending = (jobs || [])
    .filter((j) => j?.cmd)
    .map((j, i) => ({
      id: j.id || `j${i + 1}`,
      cmd: String(j.cmd),
      cwd: j.cwd || cwd,
    }));
  if (!pending.length) return [];

  const results = [];
  let next = 0;
  const live = new Map();

  const pump = () => {
    while (live.size < concurrency && next < pending.length) {
      const job = pending[next++];
      const h = spawnJob(job, shell, timeoutMs);
      live.set(job.id, h);
      onUpdate?.({
        type: 'start',
        id: job.id,
        cmd: job.cmd,
        live: live.size,
        left: pending.length - next,
        done: results.length,
        total: pending.length,
      });
      h.promise.then((res) => {
        live.delete(job.id);
        results.push(res);
        onUpdate?.({
          type: 'done',
          id: job.id,
          code: res.code,
          ms: res.ms,
          live: live.size,
          left: pending.length - next,
          done: results.length,
          total: pending.length,
        });
        pump();
      });
    }
  };

  pump();
  while (live.size || next < pending.length) {
    await sleep(120);
    onUpdate?.({
      type: 'tick',
      live: live.size,
      left: pending.length - next,
      done: results.length,
      total: pending.length,
    });
  }

  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  return pending.map((j) => byId[j.id]).filter(Boolean);
}

function spawnJob(job, shell, timeoutMs) {
  const t0 = Date.now();
  let out = '';
  const child = spawn(shell, ['-l', '-c', job.cmd], {
    cwd: job.cwd,
    env: { ...process.env, GEX_AUTOPILOT: '1', GEX_WORKER: '1', TERM: 'dumb' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const take = (b) => {
    out += b.toString();
    if (out.length > 500_000) out = out.slice(-500_000);
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);

  let done = false;
  const promise = new Promise((resolve) => {
    const fin = (code, signal) => {
      if (done) return;
      done = true;
      resolve({
        id: job.id,
        cmd: job.cmd,
        code: code ?? (signal ? 130 : 1),
        out,
        ms: Date.now() - t0,
      });
    };
    child.on('error', (e) => {
      out += `\n${e.message}`;
      fin(127, null);
    });
    child.on('close', fin);
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      out += '\n[gex worker timeout]';
      fin(124, 'SIGKILL');
    }, timeoutMs);
    timer.unref?.();
  });

  return { promise };
}

export function formatParallelBoard(results) {
  return (results || [])
    .map((r) => {
      const tail = String(r.out || '').slice(-8000);
      return `### ${r.id} exit=${r.code} ms=${r.ms}\n$ ${r.cmd}\n${tail || '(no output)'}`;
    })
    .join('\n\n');
}

export function defaultConcurrency(cpus = 4) {
  return Math.max(2, Math.min(4, Math.floor(cpus / 2) || 2));
}
