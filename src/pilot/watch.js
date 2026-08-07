/** Done when NEW output after submit ends with a shell prompt. */

export function rewriteCommand(cmd) {
  return String(cmd || '').trim();
}

function stripAnsi(s) {
  return String(s || '')
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

export function isShellPrompt(text) {
  const tail = stripAnsi(text).slice(-800);
  const lines = tail.split('\n').filter((l) => l.trim().length);
  if (!lines.length) return false;
  const last = lines[lines.length - 1];
  return (
    /╰─\s*gsh\/\d+/i.test(last) ||
    /gsh\/\d+\s*$/i.test(last) ||
    /[❯›]\s*$/.test(last) ||
    /\$\s*$/.test(last) ||
    /%\s*$/.test(last) ||
    /#\s*$/.test(last)
  );
}

export function promptAfterMark(session, mark) {
  if (session.exited) return true;
  if (session.buffer.length <= mark + 1) return false;
  const delta = stripAnsi(session.buffer.slice(mark));
  if (delta.trim().length < 2) return false;
  return isShellPrompt(delta);
}

export { classifyTail } from './interactive.js';
