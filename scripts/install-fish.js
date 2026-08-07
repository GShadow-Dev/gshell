import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gexJs = path.join(root, 'bin', 'gex.js');
const fnDir = path.join(os.homedir(), '.config/fish/functions');
const fnPath = path.join(fnDir, 'gex.fish');

const body = `function gex --description 'gShell terminal autopilot — Gengar drives Ghostty'
    set -l gex_js ${gexJs}
    if not test -f $gex_js
        set_color '#ff5d45'
        echo "gex: missing $gex_js — cd gshell && npm install"
        set_color normal
        return 1
    end
    # Ensure deps
    if not test -d (dirname $gex_js)/../node_modules/node-pty
        set_color '#ffb454'
        echo 'gex: installing node-pty…'
        set_color normal
        npm --prefix (dirname $gex_js)/.. install
        or return 1
    end
    command node $gex_js $argv
    set -l code $status
    # Pull history written by the driven fish session into this shell
    history merge 2>/dev/null
    return $code
end
`;

fs.mkdirSync(fnDir, { recursive: true });
fs.writeFileSync(fnPath, body);
fs.chmodSync(gexJs, 0o755);
console.log(`gex: fish wrapper → ${fnPath}`);
