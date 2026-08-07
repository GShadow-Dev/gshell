# gShell / gex — Status, WIP, Long Horizon

**Date:** 2026-08-07  
**Repo:** `~/Documents/gshell` · `GShadow-Dev/gshell` · branch `main`  
**Command:** `gex` (not sgpt) · Brand: GShadow / Ember Glass / Fincher Labs  
**Model in use:** DeepSeek chat via `DEEPSEEK_API_KEY`  
**Purpose of this file:** Handoff for a stronger model / next session. Read this before coding.

---

## North star

**gex = AI-native terminal autopilot for Ghostty.**  
Gengar drives a *live* fish PTY: types commands, watches output, answers prompts, steers mid-flight, remembers the room.  

**Hard product rules (do not violate):**
1. **Dynamic, not scenario-hardcoded.** No Music/HomePod/nmap special cases. Principles + survey + toolkit only.
2. **Best tool wins.** Prefer installing/using the right binary over abusing a worse one.
3. **Sacred scrollback.** Status only on the bottom bar. No dance spam in logs.
4. **User can always interrupt.** `steer›` type+enter · Ctrl-C shell · Ctrl-C×2 abort.
5. **Real work only.** Reject hollow `Done.`, empty submits, plan-only turns, fail-loops.
6. **Prompt engineering is load-bearing.** All model-facing copy lives in `src/prompts.js`.

---

## What exists today (shipped on `main`)

### Core loop
| Piece | Path | Role |
|---|---|---|
| CLI | `bin/gex.js`, `src/cli.js` | Entry, env, steer wire, room memory, HEX print |
| Agent | `src/agent.js` | LLM loop, gates, exec, fail-map, parallel, install |
| Prompts | `src/prompts.js` | SYSTEM, userBrief, REJECT, snap decide |
| PTY | `src/pty_session.js` | node-pty fish session, submit/type/key, multiline→temp bash |
| Gengar UI | `src/gengar.js` | Bottom status bar + intro sprite |
| Steer | `src/steer.js` | Always-on `steer›`, filters Ghostty DCS junk |
| Term filter | `src/term_queries.js` | Answer VT/kitty queries so nested PTY doesn’t hang |
| Watch | `src/pilot/watch.js` | prompt-after-mark completion (no tool allowlists) |
| Interactive | `src/pilot/interactive.js` | y/n + menu snap-decide (fast model call) |
| Scheduler | `src/pilot/scheduler.js` | parallel job runner |
| Survey | `src/mind/survey.js` | PATH bins, project markers, can_install (generic) |
| Toolkit | `src/mind/toolkit.js` | catalog + playbooks + recordWin (task-tag keyed) |
| Memory | `src/memory/*` | room id, ledger ndjson, blobs, summon pack, distill |
| Fish | `fish/gex.fish`, `40-gex-scribe.fish`, `41-gex-bind.fish` | wrapper, scribe, enter-protect for `gex …` |

### Behaviors already working
- Live PTY possession (not “suggest a command”)
- Efficiency card required before work; host rejects plan-only / hollow done
- Install-then-use path (`action=install`) when best tool missing
- Parallel fanout jobs
- Reactive confirm autopilot (y/n) + mid-run cancel intent
- Long-run watch with heartbeat (doesn’t burn steps every second)
- Room memory + scribe of user commands between summons
- Signature-based fail loop: same *command shape* blocked after 2 fails; same bin after 3
- Real exit inference from fish `✘ N` + error text (not always-0)
- Multiline/heredoc submit → temp bash script (fish is hostile to bash heredocs)
- Optional `{"command":"osascript","script":"…"}` materialize path (general interpreters)
- Fish bind: only rewrites *interactive user* `gex …` lines; **skips when `GEX_AUTOPILOT=1`**

### Recent commits (newest first)
```
a26cf7a fix gex: signature anti-loop + real exit + clean steer
93fa4e5 fix gex: anti-loop + always-on steer line
f0cbea6 use shared snap prompts in fastDecide
a27f934 fix gex: engineered prompts + reject hollow Done
72400d4 gex: system-wide efficiency — best tool wins, including installs
… earlier: watch mode, room memory, VT query filter, fish bind
```

---

## What is broken / WIP right now

### P0 — Multiline / script execution reliability
**Symptom:** Model tries `osascript -e '…'` (wrong AirPlay syntax) then retries near-identical commands; when it tries heredocs, fish bind / single-line paste collapses them (`osascript <<'EOF'tell…` one line) and `__gex_bind_execute` errors.

**Cause (general, not Music-specific):**
1. Fish interactive Enter bind was intercepting *all* Enter — **fixed in tree** (`GEX_AUTOPILOT` skip + only single-line `gex`). Needs install + verify.
2. Models emit single-line `-e` chains or broken one-line heredocs.
3. Host now supports: real newlines in `command`, `\\n` expansion, and `script` body → temp file. **Needs end-to-end verify in real Ghostty.**

**Verify:**
```fish
cd ~/Documents/gshell && git pull && npm run postinstall
# In Ghostty (real TTY):
gex -- "play end of summer by tame impala on apple music to bedroom or homepod"
# Should NOT spam the same failing osascript; should use script/heredoc/file and change approach.
# While running, type on steer›: stuck
```

### P0 — Steer usability under Gengar bar
Steer line paints row `rows-1`; Ghostty sometimes injects `P>|ghostty…` — filter added. Confirm typing still works during long `thinking` (model call) and `watching`.

### P1 — agent.js edit fragility
Repeated mid-file surgical edits corrupted `agent.js` (orphan braces, half helpers). Prefer **full-function rewrites** or small python/ast patches. Always `node --check src/agent.js` before commit.

### P1 — Model quality / loop intelligence
DeepSeek often:
- locks onto one broken command shape
- invents wrong AppleScript class names (`airplay devices` vs `AirPlay device`)
- says Done too early (partially gated)
- underuses `script` field and survey

**Not solved by hardcoding Music.** Solved by better prompts, better TOOL_RESULT coaching, fail-map (done), maybe tool docs in survey (“osascript exists”), and stronger model.

### P2 — Playbook poisoning
Seeded efficiency/playbooks can bias wrong. Match is tag-based; bad wins get recorded. Need quality bar on `recordWin` and playbook match confidence.

### P2 — Exit codes
`inferExit` heuristics help; still no true child exit from the interactive fish line in all cases. Consider `echo GEX_EXIT:$status` wrapper for submitted commands (generic).

---

## Design principles (for the smarter model)

### DO
- Keep gex **domain-agnostic**. Survey facts → efficiency → act → read → adapt.
- Put **all** model-facing strings in `src/prompts.js`.
- Teach *how to recover*: read error, change tool/flags/quoting, use `script` for multi-line, install missing bins.
- Prefer host-side **capability** (multiline submit, fail loops, steer) over prompt-only hope.
- Test in **real Ghostty TTY** (`PtySession` refuses non-TTY).

### DO NOT
- Hardcode HomePod names, track titles, nmap flags, brew formulae lists as special cases.
- Add Pokémon / franchise identity (GShadow brand rules).
- Burn scrollback with status spam.
- Reintroduce sgpt / ShellGPT naming.
- Ship with `node --check` failing.

---

## Immediate next tasks (ordered)

1. **Commit + push** current WIP if clean:
   - `fish/41-gex-bind.fish` autopilot skip
   - `src/pty_session.js` multiline temp bash
   - `src/agent.js` `\\n` expand + `script` materialize
   - `src/prompts.js` document script field
2. **E2E in Ghostty** for:
   - simple: `gex show me system stats` (must run real cmds + HEX)
   - hard: natural language Music → HomePod (must not fail-loop; may still need model skill)
   - multiline: model uses `script` or heredoc successfully
   - steer: type `stuck` mid-run → approach changes
3. **Generic exit wrapper** (optional but high leverage):
   ```text
   submit(cmd) → eval cmd; echo __GEX_EXIT:$status
   ```
   Parse marker; feed exact exit into fail-map + TOOL_RESULT.
4. **Prompt pass** with a stronger model:
   - Tighten ON ERROR / multi-line / script examples (still generic).
   - Add “discover API before use” principle (e.g. `osascript -e '…get name of every…'` before mutate) — principle, not Music-only.
5. **Playbook hygiene:** only recordWin when ok + commands non-empty + message not hollow; decay bad playbooks.
6. **Tests that don’t need Ghostty:** pure unit tests for `cmdSignature`, `inferExit`, `materializeScript`, steer sanitize, survey PATH.
7. **Model routing:** allow stronger model for plan/efficiency + deepseek/fast for snap-decide; env `GEX_MODEL` / `GEX_SNAP_MODEL`.

---

## Long horizon

### Horizon A — Terminal-max operator (near)
- Efficiency card + toolkit + swarm + progressive HEX are solid defaults for *any* task.
- Self-improving playbooks per machine (what flags won last time).
- Install-to-win with user-visible amber risk.
- Possession that feels instant (local snap heuristics + tiny model).

### Horizon B — Mind layer
- Structured memory graph (entities: hosts, services, repos, tools) not only blobs.
- Cross-session skill cards: “how I run osascript safely”, “how I fanout nmap” as *learned* recipes with evidence, not code branches.
- Critic pass: second call that only checks “did TOOL_RESULT actually satisfy TASK?”

### Horizon C — Product surface
- `gsh` shell brand polish (already gSHELL fish theme) fully unified with gex.
- Optional GUI / HUD later — still Ember Glass tokens; operational density.
- Multi-room / multi-tab awareness.
- Safe mode / dry-run / risk ladder for destructive cmds.

### Horizon D — Platform
- Provider-agnostic LLM (OpenAI/Anthropic/DeepSeek/local).
- Policy engine (never rm -rf /, never send secrets).
- Plugin tools as MCP-like functions *in addition to* raw shell — still dynamic.

---

## Architecture sketch

```text
User (Ghostty + fish)
   │  gex <task>
   ▼
cli.js ──► SteerInput (stdin raw) ──► steerQueue
   │
   ▼
runAgent (agent.js)
   ├─ surveyMachine (facts only)
   ├─ Toolkit playbook seed (optional)
   ├─ messages: SYSTEM + userBrief
   └─ loop:
        drainSteers → callModel → gate → act
           ├ install / submit / parallel
           ├ InteractiveAutopilot (prompt snaps)
           ├ watchUntilPrompt (new prompt after mark)
           └ TOOL_RESULT coach (REJECT.afterTool)
   ▼
PtySession (fish -i, GEX_AUTOPILOT=1)
   multiline/script → temp file → bash/osascript/python
   ▼
ledger + blobs + distill → next summon pack
```

---

## Key files to read first (smarter model onboarding)

1. `TODO.md` (this file)
2. `src/prompts.js` — all model copy
3. `src/agent.js` — loop + gates + fail-map
4. `src/pty_session.js` — submit semantics
5. `src/steer.js` — interrupt UX
6. `src/mind/survey.js` + `toolkit.js` — dynamic mind
7. `fish/41-gex-bind.fish` — Enter bind pitfalls
8. Brand: `/tmp/gshadow-brand-guidelines` or clone `GShadow-Dev/gshadow-brand-guidelines`

---

## Open questions for product owner

1. Default model: stay on DeepSeek or route hard tasks to a stronger API?
2. How aggressive should auto-install be without prompt? (currently model-decided via efficiency.install)
3. Should progressive HEX be default-on for long tasks?
4. Memory retention / privacy: room-local only forever, or exportable skill packs?

---

## One-liner for the next agent

> **Do not hardcode scenarios.** Fix general host capabilities (submit, exits, steer, fail-loops, prompts) so gex stays dynamically intelligent. Verify in real Ghostty. Keep `src/prompts.js` as the single prompt surface. Make multiline `script` + anti-loop so natural-language tasks like “play X to HomePod” succeed *because the agent can run real multi-line automation*, not because Music is special-cased.
