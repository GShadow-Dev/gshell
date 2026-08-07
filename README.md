# gShell / gex

**Terminal autopilot for Ghostty.** Gengar drives your live fish shell.

No special app UI. Native TTY only. A dancing fire-Gengar on the left is the sole chrome.

## gex

```fish
gex show me system stats
gex scaffold a nextjs app called dashboard
gex find a file with fzf and open it
```

### What you see
- Your real terminal output (PTY) — full fidelity, fzf/wizards/tab work
- Fire Gengar sprite on the left, hands dancing while he works
- Bottom `steer>` — type and hit Enter to redirect him mid-flight

### What he can do
- Type commands (land in the driven session’s history)
- Tab, arrows, ctrl-c, ctrl-r, menus, interactive installers
- Pick settings himself (Next.js flags, package managers) — no handoff

### Steer
| Input | Effect |
|---|---|
| type + Enter | STEER message to Gengar |
| `stop` / `abort` | End autopilot |
| Ctrl-C | ctrl-c into driven shell |
| Ctrl-C twice | Abort gex |

## Install

```fish
cd ~/Documents/gshell   # or clone GShadow-Dev/gshell
npm install             # builds node-pty + installs fish wrapper
```

Requires: Ghostty, fish, Node 20+, `chafa`, `DEEPSEEK_API_KEY`.

```fish
# key already in conf.d on this machine:
# ~/.config/fish/conf.d/20-deepseek.fish
```

## Layout

```
bin/gex.js           CLI
src/cli.js           autopilot wiring
src/pty_session.js   live PTY mirror
src/agent.js         model loop (submit/type/key/wait/done)
src/gengar.js        dancing sprite (kitty/chafa)
src/steer.js         keyboard → steer queue
assets/fire-gengar.png
```

## Brand
Ember Glass · GShadow · Fincher Labs
