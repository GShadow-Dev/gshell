import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gexJs = path.join(root, 'bin', 'gex.js');
const fishSrc = path.join(root, 'fish');
const fnDir = path.join(os.homedir(), '.config/fish/functions');
const confDir = path.join(os.homedir(), '.config/fish/conf.d');

fs.mkdirSync(fnDir, { recursive: true });
fs.mkdirSync(confDir, { recursive: true });

fs.copyFileSync(path.join(fishSrc, 'gex.fish'), path.join(fnDir, 'gex.fish'));
fs.copyFileSync(path.join(fishSrc, '40-gex-scribe.fish'), path.join(confDir, '40-gex-scribe.fish'));
fs.copyFileSync(path.join(fishSrc, '41-gex-bind.fish'), path.join(confDir, '41-gex-bind.fish'));
fs.chmodSync(gexJs, 0o755);

console.log(`gex: fish wrapper → ${path.join(fnDir, 'gex.fish')}`);
console.log(`gex: scribe hook  → ${path.join(confDir, '40-gex-scribe.fish')}`);
console.log(`gex: enter bind   → ${path.join(confDir, '41-gex-bind.fish')}`);
