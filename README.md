# gShell / gex

**Terminal autopilot for Ghostty.** Gengar possesses your live fish shell.

Native TTY only. Bottom status sprite (no scroll poison). Enter steers. Room memory survives the gap.

## Quick start

```fish
cd ~/Documents/gshell && npm install   # once
gex show me system stats
gex please update homebrew apps
gex recall brew                       # dump memory pack
```

Requires: Ghostty, fish, Node 20+, chafa, `DEEPSEEK_API_KEY`.

## What you get

| Piece | Behavior |
|---|---|
| **Pilot** | Live PTY — tab, arrows, ctrl-*, brew y/n, wizards |
| **Surface** | Gengar status on the **bottom row only** (states: thinking/casting/watching/speaking) |
| **Steer** | Type + Enter while he works · `stop` aborts · Ctrl-C → shell · twice → abort gex |
| **Watch mode** | Long jobs (brew/npm/cargo) don’t burn LLM steps |
| **Memory** | Per-room ledger + blobs + session distill · summon pack + `memory_search` |
| **Scribe** | Fish hooks log *your* commands between summons |

## Memory layout

```text
~/.cache/gex/
  rooms/<room_id>/
    ledger.ndjson      # append-only events
    blobs/*.txt        # full command screens
    summaries/         # distilled session cards
  scribe/<tty>.ndjson  # your cmds while gex sleeps
  last-exit.json
```

Room id ≈ host + tty + parent fish pid. Same tab → same brain.

## Architecture

```text
Surface (Gengar bar + steer) → Pilot (PTY + watch + confirms) → Mind (LLM)
                                      ↓
                              Memory (ledger/graph-ready/retrieve)
```

## Project

```text
bin/gex.js
src/cli.js
src/agent.js
src/gengar.js
src/pty_session.js
src/steer.js
src/term_queries.js
src/pilot/watch.js
src/memory/{room,ledger,retrieve,distill}.js
assets/fire-gengar.png
```

## Brand

Ember Glass · GShadow · Fincher Labs  
*Green dashboards lie. I check the bodies.*
