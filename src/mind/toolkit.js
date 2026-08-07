import fs from 'node:fs';
import path from 'node:path';
import { gexHome } from '../memory/room.js';

/**
 * Personal toolset + winning recipes for any goal.
 * Installs are first-class: better tool > clever flags on a worse tool.
 */
export class Toolkit {
  constructor() {
    this.root = path.join(gexHome(), 'toolkit');
    fs.mkdirSync(this.root, { recursive: true });
    this.catalogPath = path.join(this.root, 'catalog.json');
    this.playbooksPath = path.join(this.root, 'playbooks.json');
    this.benchPath = path.join(this.root, 'bench.json');
    this.catalog = load(this.catalogPath, { tools: {} });
    this.playbooks = load(this.playbooksPath, { recipes: [] });
    this.bench = load(this.benchPath, { runs: [] });
  }

  save() {
    write(this.catalogPath, this.catalog);
    write(this.playbooksPath, this.playbooks);
    write(this.benchPath, this.bench);
  }

  noteTool(name, fields = {}) {
    const key = norm(name);
    if (!key) return;
    const prev = this.catalog.tools[key] || { name: key, uses: 0 };
    this.catalog.tools[key] = {
      ...prev,
      ...fields,
      name: key,
      uses: (prev.uses || 0) + (fields.used ? 1 : 0),
      last_used: new Date().toISOString(),
    };
    this.save();
  }

  /**
   * Build an install command for a missing binary using whatever installer exists.
   * Mind still decides WHETHER to install; this only answers HOW on this machine.
   */
  installCommand(bin, survey) {
    const b = norm(bin);
    if (!b) return null;
    const can = survey?.can_install || {};
    const bins = new Set(survey?.path_bins || []);
    if (can.brew || bins.has('brew')) return `brew install ${b}`;
    if (can.cargo || bins.has('cargo')) return `cargo install ${b}`;
    if (can.uv || bins.has('uv')) return `uv tool install ${b}`;
    if (can.go || bins.has('go')) return `go install ${b}@latest`;
    if (can.npm_global || bins.has('npm')) return `npm install -g ${b}`;
    if (can.pip || bins.has('pip3')) return `pip3 install --user ${b}`;
    return null;
  }

  matchPlaybook(task) {
    const tags = goalTags(task);
    let best = null;
    let bestScore = 0;
    for (const r of this.playbooks.recipes || []) {
      const score = overlap(tags, r.goal_tags || []);
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    if (!best || bestScore < 1) return null;
    return { ...best, match_score: bestScore, query_tags: tags };
  }

  recordWin({ task, efficiency, commands = [], wall_ms = 0, ok = true }) {
    if (!ok) return;
    const tags = goalTags(task);
    const recipe = {
      goal_tags: tags,
      efficiency: efficiency || null,
      commands: commands.slice(0, 24),
      wall_ms: wall_ms || 0,
      wins: 1,
      last_success: new Date().toISOString(),
    };
    const idx = (this.playbooks.recipes || []).findIndex((r) =>
      sameTagSet(r.goal_tags || [], tags),
    );
    if (idx >= 0) {
      const prev = this.playbooks.recipes[idx];
      const better = wall_ms > 0 && (!prev.wall_ms || wall_ms < prev.wall_ms * 0.95);
      this.playbooks.recipes[idx] = {
        ...prev,
        efficiency: better ? recipe.efficiency : prev.efficiency,
        commands: better ? recipe.commands : prev.commands,
        wall_ms: better ? wall_ms : prev.wall_ms,
        wins: (prev.wins || 0) + 1,
        last_success: recipe.last_success,
      };
    } else {
      this.playbooks.recipes.push(recipe);
      if (this.playbooks.recipes.length > 100) {
        this.playbooks.recipes = this.playbooks.recipes
          .sort((a, b) => (b.wins || 0) - (a.wins || 0))
          .slice(0, 100);
      }
    }
    this.bench.runs.push({
      at: recipe.last_success,
      tags,
      wall_ms,
      commands: commands.slice(0, 12),
    });
    if (this.bench.runs.length > 250) this.bench.runs = this.bench.runs.slice(-250);
    for (const c of commands) {
      const tok = String(c || '')
        .trim()
        .split(/\s+/)
        .find((t) => t && !t.includes('='));
      if (tok) this.noteTool(path.basename(tok), { used: true });
    }
    this.save();
  }

  formatPlaybook(pb) {
    if (!pb) return '(none)';
    return JSON.stringify({
      match_score: pb.match_score,
      goal_tags: pb.goal_tags,
      wall_ms: pb.wall_ms,
      wins: pb.wins,
      efficiency: pb.efficiency,
      commands: pb.commands,
    });
  }

  formatCatalog(limit = 50) {
    const tools = Object.values(this.catalog.tools || {})
      .sort((a, b) => (b.uses || 0) - (a.uses || 0))
      .slice(0, limit);
    if (!tools.length) return '(empty — grows when gex installs/uses tools)';
    return tools
      .map(
        (t) =>
          `${t.name} uses=${t.uses || 0}${t.installed ? ' installed' : ''}${
            t.purpose ? ` (${t.purpose})` : ''
          }`,
      )
      .join('; ');
  }
}

export function goalTags(task) {
  const words = String(task || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s+-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'please',
    'just', 'into', 'have', 'any', 'all', 'can', 'you', 'me', 'my', 'are',
    'was', 'but', 'not', 'how', 'what', 'when', 'then', 'out', 'use',
  ]);
  const tags = [];
  for (const w of words) {
    if (stop.has(w)) continue;
    if (!tags.includes(w)) tags.push(w);
    if (tags.length >= 14) break;
  }
  return tags.length ? tags : ['general'];
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9._+-]/g, '')
    .slice(0, 48);
}

function overlap(a, b) {
  const s = new Set(b);
  return a.reduce((n, x) => n + (s.has(x) ? 1 : 0), 0);
}

function sameTagSet(a, b) {
  return [...a].sort().join() === [...b].sort().join();
}

function load(fp, fb) {
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    /* ignore */
  }
  return fb;
}

function write(fp, obj) {
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
}
