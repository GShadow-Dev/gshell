export function keyToBytes(name) {
  const k = String(name || '').toLowerCase();
  const table = {
    enter: '\r',
    return: '\r',
    tab: '\t',
    space: ' ',
    escape: '\x1b',
    esc: '\x1b',
    backspace: '\x7f',
    delete: '\x1b[3~',
    up: '\x1b[A',
    down: '\x1b[B',
    right: '\x1b[C',
    left: '\x1b[D',
    home: '\x1b[H',
    end: '\x1b[F',
    pageup: '\x1b[5~',
    pagedown: '\x1b[6~',
    'shift-tab': '\x1b[Z',
    'ctrl-c': '\x03',
    'ctrl+c': '\x03',
    'ctrl-d': '\x04',
    'ctrl+d': '\x04',
    'ctrl-z': '\x1a',
    'ctrl+z': '\x1a',
    'ctrl-l': '\x0c',
    'ctrl+l': '\x0c',
    'ctrl-a': '\x01',
    'ctrl+a': '\x01',
    'ctrl-e': '\x05',
    'ctrl+e': '\x05',
    'ctrl-u': '\x15',
    'ctrl+u': '\x15',
    'ctrl-w': '\x17',
    'ctrl+w': '\x17',
    'ctrl-r': '\x12',
    'ctrl+r': '\x12',
  };
  if (table[k]) return table[k];
  const m = k.match(/^ctrl[+-]([a-z])$/);
  if (m) return String.fromCharCode(m[1].charCodeAt(0) - 96);
  if (name.length === 1) return name;
  throw new Error(`unknown key: ${name}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
