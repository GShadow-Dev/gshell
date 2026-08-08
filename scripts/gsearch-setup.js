#!/usr/bin/env node
/**
 * GSearch bootstrap — works from scratch on a clean machine.
 *
 *   node scripts/gsearch-setup.js            # diagnose only (safe, default)
 *   node scripts/gsearch-setup.js --install  # actually install what's missing
 *   node scripts/gsearch-setup.js --down     # stop the local Firecrawl stack
 *
 * Tiers, so a fresh machine is useful immediately:
 *   Context7  — network only, ZERO infra. Works the moment gex is installed.
 *   Firecrawl — optional power-up, needs a container runtime.
 * Nothing here is required for gex to run; GSearch degrades to local
 * discovery when neither backend is present.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const FC_DIR = path.join(HOME, '.cache', 'gex', 'firecrawl');
const FC_URL = process.env.FIRECRAWL_BASE || 'http://localhost:3002';
const args = new Set(process.argv.slice(2));
const DO_INSTALL = args.has('--install');
const DO_DOWN = args.has('--down');

const C = {
  ember: (s) => `\x1b[38;2;255;122;24m${s}\x1b[0m`,
  ok: (s) => `\x1b[38;2;145;196;131m${s}\x1b[0m`,
  warn: (s) => `\x1b[38;2;255;180;84m${s}\x1b[0m`,
  bad: (s) => `\x1b[38;2;255;93;69m${s}\x1b[0m`,
  dim: (s) => `\x1b[38;2;95;104;115m${s}\x1b[0m`,
};

const log = (s = '') => process.stdout.write(`${s}\n`);

function has(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

function run(cmd, argv, { quiet = false, cwd } = {}) {
  log(C.dim(`  $ ${cmd} ${argv.join(' ')}`));
  const r = spawnSync(cmd, argv, {
    stdio: quiet ? 'ignore' : 'inherit',
    cwd,
    // Firecrawl's Dockerfile uses `RUN --mount=...`, which legacy
    // docker-compose v1 cannot build without BuildKit turned on explicitly.
    env: { ...process.env, DOCKER_BUILDKIT: '1', COMPOSE_DOCKER_CLI_BUILD: '1' },
  });
  return r.status === 0;
}

async function ping(url, ms = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Container runtime that is present AND actually running.
 *
 * macOS note: Apple ships a native `container` CLI (Apple Silicon) that is
 * lighter than any VM-based option — we prefer it as the general runtime.
 * BUT it has no compose plugin, and Firecrawl self-host is a multi-service
 * stack (api + worker + redis + playwright). So `compose` capability is
 * tracked separately from `runtime` capability: Apple container satisfies
 * the first, not the second.
 */
function containerRuntime() {
  const order =
    process.platform === 'darwin'
      ? ['container', 'docker', 'podman']
      : ['docker', 'podman'];
  for (const bin of order) {
    if (!has(bin)) continue;
    const probe = bin === 'container' ? ['system', 'status'] : ['info'];
    const r = spawnSync(bin, probe, { stdio: 'ignore' });
    return { bin, running: r.status === 0, apple: bin === 'container' };
  }
  return { bin: null, running: false, apple: false };
}

/** Apple's container needs its launchd services up before anything works. */
function startAppleContainer() {
  return run('container', ['system', 'start']);
}

/**
 * Homebrew installs the compose v2 plugin somewhere the docker CLI does not
 * look by default, so `docker compose` silently 404s and callers fall back to
 * legacy docker-compose v1 — which cannot build BuildKit Dockerfiles at all
 * (Firecrawl's uses `RUN --mount=...`). Register the plugin dir once.
 */
function ensureBuildx() {
  if (has('docker') && spawnSync('docker', ['buildx', 'version'], { stdio: 'ignore' }).status !== 0) {
    if (process.platform === 'darwin' && has('brew')) {
      log(C.ember('  Installing docker-buildx (required for BuildKit builds)…'));
      run('brew', ['install', 'docker-buildx']);
    }
  }
}

function ensureComposePlugin() {
  if (process.platform !== 'darwin') return;
  const dir = '/opt/homebrew/lib/docker/cli-plugins';
  if (!fs.existsSync(dir)) return;
  const cfgPath = path.join(HOME, '.docker', 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    /* missing or malformed — start fresh */
  }
  const dirs = new Set(cfg.cliPluginsExtraDirs || []);
  if (dirs.has(dir)) return;
  dirs.add(dir);
  cfg.cliPluginsExtraDirs = [...dirs];
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  log(C.dim(`  registered compose v2 plugin dir in ${cfgPath}`));
}

/** Resolve how to invoke `compose` for a given runtime binary. */
function composeArgs(bin) {
  if (bin === 'container') {
    const r = spawnSync('container', ['compose', 'version'], { stdio: 'ignore' });
    return r.status === 0 ? { cmd: 'container', pre: ['compose'] } : null;
  }
  if (bin === 'docker') {
    const r = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    if (r.status === 0) return { cmd: 'docker', pre: ['compose'] };
    if (has('docker-compose')) return { cmd: 'docker-compose', pre: [] };
    return null;
  }
  if (bin === 'podman') {
    if (has('podman-compose')) return { cmd: 'podman-compose', pre: [] };
    const r = spawnSync('podman', ['compose', 'version'], { stdio: 'ignore' });
    if (r.status === 0) return { cmd: 'podman', pre: ['compose'] };
    return null;
  }
  return null;
}

/** Any runtime on this machine that can actually run `compose`. */
function composeCapable() {
  ensureComposePlugin();
  ensureBuildx();
  for (const bin of ['docker', 'podman']) {
    if (!has(bin)) continue;
    const r = spawnSync(bin, ['info'], { stdio: 'ignore' });
    if (r.status === 0 && composeArgs(bin)) return { bin, running: true };
  }
  // Apple container *may* gain a compose plugin in future versions.
  if (has('container')) {
    const r = spawnSync('container', ['compose', '--help'], { stdio: 'ignore' });
    if (r.status === 0) return { bin: 'container', running: true };
  }
  return null;
}

/** Install a container runtime appropriate to this OS. */
function installRuntime() {
  const p = process.platform;
  if (p === 'darwin') {
    if (!has('brew')) {
      log(C.bad('  Homebrew is required to auto-install a runtime on macOS.'));
      log(C.dim('  Install it: https://brew.sh  — then re-run with --install'));
      return false;
    }
    // 1) Apple's native container runtime first — no VM, ships with macOS
    //    tooling on Apple Silicon and is the lightest option available.
    if (!has('container')) {
      log(C.ember("  Installing Apple's native container runtime…"));
      run('brew', ['install', 'container']);
    }
    if (has('container')) {
      log(C.ember('  Starting Apple container services…'));
      startAppleContainer();
    }
    // 2) Firecrawl's stack needs `compose` AND `buildx` — its Dockerfile uses
    //    `RUN --mount=...`, which only BuildKit can build, and BuildKit needs
    //    the buildx plugin. Without it docker silently uses the legacy builder
    //    and the build fails deep in the image. Apple container provides
    //    neither, so colima (CLI-only, no Docker Desktop) covers both.
    if (!composeCapable()) {
      log(
        C.warn(
          '  Apple container has no compose plugin — Firecrawl needs multi-service orchestration.',
        ),
      );
      log(C.ember('  Installing colima + docker CLI + compose + buildx…'));
      if (!run('brew', ['install', 'colima', 'docker', 'docker-compose', 'docker-buildx']))
        return false;
      // Firecrawl's stack is heavy (api, worker, redis, rabbitmq, postgres,
      // foundationdb, playwright) and its api service reserves >2 CPUs, so a
      // 2-CPU VM fails at container-create time AFTER a long image build.
      // Size from the host, leaving headroom for the user's own work.
      const hostCpus = os.cpus()?.length || 4;
      const vmCpus = Math.max(4, Math.min(6, hostCpus - 4));
      const vmMem = vmCpus >= 6 ? '10' : '8';
      log(C.ember(`  Starting colima VM (${vmCpus} cpu / ${vmMem}GB)…`));
      if (!run('colima', ['start', '--cpu', String(vmCpus), '--memory', vmMem]))
        return false;
    }
    return Boolean(composeCapable());
  }
  // TODO(cross-platform): Linux and Windows paths below are written but
  // UNVERIFIED — current scope is macOS-first. Test before relying on them.
  if (p === 'linux') {
    if (has('apt-get')) {
      log(C.ember('  Installing docker.io via apt (needs sudo)…'));
      return (
        run('sudo', ['apt-get', 'update']) &&
        run('sudo', ['apt-get', 'install', '-y', 'docker.io', 'docker-compose-v2'])
      );
    }
    if (has('dnf')) return run('sudo', ['dnf', 'install', '-y', 'docker', 'docker-compose']);
    if (has('pacman')) return run('sudo', ['pacman', '-S', '--noconfirm', 'docker', 'docker-compose']);
    log(C.bad('  No supported package manager found (apt/dnf/pacman).'));
    return false;
  }
  log(C.warn('  On Windows, install Docker Desktop manually:'));
  log(C.dim('  https://docs.docker.com/desktop/install/windows-install/'));
  return false;
}

/** Clone or update the Firecrawl self-host repo and bring the stack up. */
function installFirecrawl(rt) {
  if (!has('git')) {
    log(C.bad('  git is required to fetch Firecrawl.'));
    return false;
  }
  fs.mkdirSync(path.dirname(FC_DIR), { recursive: true });
  if (!fs.existsSync(path.join(FC_DIR, '.git'))) {
    log(C.ember(`  Cloning Firecrawl → ${FC_DIR}`));
    if (
      !run('git', [
        'clone', '--depth', '1',
        'https://github.com/firecrawl/firecrawl.git',
        FC_DIR,
      ])
    ) {
      return false;
    }
  } else {
    log(C.dim('  Firecrawl already cloned — pulling latest'));
    run('git', ['pull', '--ff-only'], { cwd: FC_DIR });
  }

  // Self-host needs a .env; ship a minimal working one if absent.
  const envPath = path.join(FC_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    const example = path.join(FC_DIR, '.env.example');
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, envPath);
      log(C.dim('  .env created from .env.example'));
    } else {
      fs.writeFileSync(
        envPath,
        [
          'NUM_WORKERS_PER_QUEUE=2',
          'PORT=3002',
          'HOST=0.0.0.0',
          'REDIS_URL=redis://redis:6379',
          'REDIS_RATE_LIMIT_URL=redis://redis:6379',
          'PLAYWRIGHT_MICROSERVICE_URL=http://playwright-service:3000/scrape',
          'USE_DB_AUTHENTICATION=false',
          '',
        ].join('\n'),
      );
      log(C.dim('  .env created with self-host defaults'));
    }
  }

  const compose = composeArgs(rt.bin);
  if (!compose) {
    log(C.bad('  No compose plugin found for ' + rt.bin));
    return false;
  }
  const file = ['docker-compose.yaml', 'docker-compose.yml', 'compose.yaml']
    .map((f) => path.join(FC_DIR, f))
    .find((f) => fs.existsSync(f));
  if (!file) {
    log(C.bad('  No compose file in the Firecrawl repo — layout may have changed.'));
    log(C.dim(`  Inspect ${FC_DIR} and bring it up manually.`));
    return false;
  }
  log(C.ember('  Starting Firecrawl stack (first run pulls images — slow)…'));
  return run(compose.cmd, [...compose.pre, 'up', '-d'], { cwd: FC_DIR });
}

function stopFirecrawl() {
  const rt = containerRuntime();
  const compose = rt.bin ? composeArgs(rt.bin) : null;
  if (!compose || !fs.existsSync(FC_DIR)) {
    log(C.warn('Nothing to stop.'));
    return;
  }
  run(compose.cmd, [...compose.pre, 'down'], { cwd: FC_DIR });
  log(C.ok('Firecrawl stack stopped.'));
}

async function main() {
  log(C.ember('\n󰈸 GSearch — tiered evidence lookup for gex\n'));

  if (DO_DOWN) {
    stopFirecrawl();
    return;
  }

  // ---- Tier 1: Context7 (no infra) ----
  log(C.ember('Context7 (versioned library/API docs — no infra required)'));
  const c7 = await ping('https://context7.com/api/v1/search?query=test', 6000);
  if (c7) {
    log(`  ${C.ok('reachable')} ${C.dim('— works on any machine with network')}`);
  } else {
    log(`  ${C.warn('unreachable')} ${C.dim('— offline, or the endpoint moved')}`);
  }
  log(
    C.dim(
      `  CONTEXT7_API_KEY ${process.env.CONTEXT7_API_KEY ? 'set' : 'not set (optional — raises rate limits)'}`,
    ),
  );

  // ---- Tier 2: Firecrawl (optional, containerised) ----
  log(C.ember('\nFirecrawl (official-docs crawling — optional power-up)'));
  let fcUp = await ping(`${FC_URL}/test`, 2500);
  if (fcUp) {
    log(`  ${C.ok('running')} at ${FC_URL}`);
  } else {
    const rt = containerRuntime();
    log(
      `  ${C.warn('not running')} ${C.dim(
        `— runtime: ${rt.bin ? `${rt.bin} (${rt.running ? 'up' : 'installed, not started'})` : 'none installed'}`,
      )}`,
    );
    if (DO_INSTALL) {
      // Firecrawl needs COMPOSE, not just a runtime. Apple container gives us
      // a runtime but no compose plugin, so check the right capability here.
      let compose = composeCapable();
      if (!compose) {
        if (!installRuntime()) {
          log(
            C.bad(
              '\n  Could not provision a compose-capable runtime. GSearch runs Context7-only.',
            ),
          );
        }
        compose = composeCapable();
      }
      if (compose) {
        log(C.dim(`  compose provider: ${compose.bin}`));
        if (installFirecrawl(compose)) {
          log(C.dim('  Waiting for Firecrawl to become healthy…'));
          for (let i = 0; i < 45 && !fcUp; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            fcUp = await ping(`${FC_URL}/test`, 2000);
          }
          log(
            fcUp
              ? `  ${C.ok('Firecrawl is up')} at ${FC_URL}`
              : C.warn('  Still starting — images may still be building. Check container logs.'),
          );
        }
      }
    } else {
      log(C.dim('  Re-run with --install to set this up automatically.'));
    }
  }

  // ---- Verdict ----
  log(C.ember('\nGSearch status'));
  const tiers = [
    ['local discovery', true, 'always available (action=discover)'],
    ['context7', c7, 'library/API docs'],
    ['firecrawl', fcUp, 'official documentation sites'],
  ];
  for (const [name, up, note] of tiers) {
    log(`  ${up ? C.ok('●') : C.dim('○')} ${name.padEnd(17)} ${C.dim(note)}`);
  }
  log(
    `\n${C.dim('gex works with none of these — GSearch only adds off-machine evidence.')}\n`,
  );
}

main().catch((e) => {
  log(C.bad(`gsearch-setup failed: ${e.message}`));
  process.exit(1);
});
