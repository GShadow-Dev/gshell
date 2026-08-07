import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Facts about the machine + cwd. No task-specific logic.
 * Mind uses this to decide: use what's here vs install something better.
 */
export function surveyMachine(cwd = process.cwd()) {
  const path_bins = listPathExecutables();
  const project_markers = listMarkers(cwd);
  return {
    cwd,
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus()?.length || 1,
    free_mb: Math.round(os.freemem() / 1e6),
    shell: process.env.SHELL || null,
    path_bins,
    project_markers,
    git: gitFacts(cwd),
    can_install: {
      brew: path_bins.includes('brew'),
      npm_global: path_bins.includes('npm'),
      cargo: path_bins.includes('cargo'),
      uv: path_bins.includes('uv'),
      pip: path_bins.includes('pip3') || path_bins.includes('pip'),
      go: path_bins.includes('go'),
    },
    at: new Date().toISOString(),
  };
}

export function formatSurvey(s) {
  return [
    `cwd=${s.cwd}`,
    `platform=${s.platform}/${s.arch} cpus=${s.cpus} free_mb=${s.free_mb}`,
    `shell=${s.shell || '?'}`,
    `git=${s.git.repo ? `branch=${s.git.branch || '?'} dirty=${s.git.dirty}` : 'no'}`,
    `project_markers=${s.project_markers.join(',') || 'none'}`,
    `can_install=${Object.entries(s.can_install)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(',') || 'none'}`,
    `path_bins_count=${s.path_bins.length}`,
    `path_bins=${s.path_bins.join(',')}`,
  ].join('\n');
}

function listPathExecutables() {
  const dirs = [
    ...String(process.env.PATH || '').split(path.delimiter),
    '/bin',
    '/usr/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), '.cargo/bin'),
  ].filter(Boolean);
  const seenDir = new Set();
  const names = new Set();
  for (const dir of dirs) {
    if (seenDir.has(dir)) continue;
    seenDir.add(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      try {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (!st.isFile() && !st.isSymbolicLink()) continue;
        if (process.platform !== 'win32' && !(st.mode & 0o111)) continue;
        names.add(name);
      } catch {
        /* ignore */
      }
      if (names.size >= 800) break;
    }
    if (names.size >= 800) break;
  }
  return [...names].sort();
}
    'package-lock.json', 'Cargo.toml', 'go.mod', 'pyproject.toml',
    'requirements.txt', 'uv.lock', 'Dockerfile', 'compose.yml',
    'docker-compose.yml', 'Makefile', 'justfile', 'Justfile',
    'tsconfig.json', 'next.config.js', 'next.config.mjs', 'next.config.ts',
    'README.md', '.git',
  ];
  return names.filter((n) => {
    try {
      return fs.existsSync(path.join(cwd, n));
    } catch {
      return false;
    }
  });
}

function gitFacts(cwd) {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return { repo: false, branch: null, dirty: false };
  }
  let branch = null;
  let dirty = false;
  try {
    branch =
      execSync('git branch --show-current', {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
  } catch {
    /* ignore */
  }
  try {
    dirty = Boolean(
      execSync('git status --porcelain', {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    /* ignore */
  }
  return { repo: true, branch, dirty };
}
