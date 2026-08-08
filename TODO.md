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

## STATE AS OF 2026-08-07 EVENING — READ THIS FIRST

### ⛔ P0 BLOCKER — rejection loop in gate() (I introduced this)
**Symptom:** runs die with `Stopped: 10 malformed/blocked turns in a row
without productive work`. Reproduced by TWO independent mock tests.
Debug output shows `REJECT.needEfficiency` firing repeatedly even though
call 1 supplied a valid efficiency card, i.e. `efficiencyLocked` reads
false when it should be true.

**Where to look:** `gate()` in `src/agent.js`, specifically the `done`
branch. Both failing tests exercise `done`. The most recent edits there
are the hedge/`unverifiedPremise` check and the hoisted
`verificationEarly` const — revert just that block to confirm.

**Repro:** mock `fetch`; call 1 → `{action:'submit', efficiency:{…},
command:'echo hi'}`; call 2 → `{action:'done', message:'…'}`. Log `kind`,
`efficiencyLocked`, and the returned reject string each turn.

**Until this is fixed, do not trust any agent-loop test result.**

### ✅ Verified working (tested against a real PTY / live backends)
- **fish, not zsh.** `resolveShell()` preferred stale `$SHELL`. Fixed.
- **Anti-loop for scripts.** `materializeScript` chained `; rm -f`, so exit
  status reflected `rm`, never the script → failures never recorded → 13x
  retries. Temp files now deleted from Node.
- **Batch loop detection.** parallel/discover had none. Blocks on
  REPETITION, not failure — "produced output" != "made progress" (a batch
  with one always-succeeds job looked productive forever). 2 strikes.
- **Visible parallel jobs.** Real fish job control (`begin;…;end &` + `wait`).
- **Temp scripts `cat`'d before running** — source never hidden.
- **Delta-only context.** Was feeding back the whole 16k scrollback every
  turn, so the strongest pattern in context was its own failed commands.
- **Task routing.** World-knowledge questions go to gsearch instead of
  grepping the machine. CONFIRMED IN A LIVE RUN: 7s vs 3min of ioreg.
- **GSearch retrieval.** Context7 ranking fixed (was returning
  `devices.css` for AppleScript queries); corroboration counts DISTINCT
  ORIGINS (3 topic-slices of one library are one source, not three);
  `Set.length` bug made corroboration silently always-empty; relevance
  guard returns "NO RELEVANT LIBRARY" instead of nonsense.
  Verified: zod/react/fastapi correct, nonsense → 0 confirmed.
- **Firecrawl `/v1/search`** is the tier that answers OS/scripting/idiom
  questions. Verified returning the right StackOverflow answer.

### ⚠️ Written but UNVERIFIED (blocked by the P0 above)
- Fabricated-premise gate (hedge words → demand evidence)
- Steer acknowledgment banner + faster repaint
- Two-round gsearch (round 1 vocabulary → refined round 2)

### 🔴 Known-bad behaviour still in the wild
**gex fabricates premises and dresses them in real output.** Live run:
never verified where the panel was made, filled the gap with "most likely
China", then ran a genuine `TZ=Asia/Shanghai date`. Output authentic,
answer invented. Ignored an explicit "use gsearch as proof".
This is the most dangerous failure mode here — the others *looked* broken.

**Steer is unreliable** — `watchUntilPrompt` returns early on steer while
the command keeps running (PTY race), and keystrokes were dropped during
heavy scrolling output.

### Infra (all live, installer handles from scratch)
`node scripts/gsearch-setup.js` (diagnose) / `--install` / `--down`
Five install blockers found and automated: Apple `container` has no
compose → colima fallback; compose v2 plugin dir unregistered
(`~/.docker/config.json`); `buildx` missing → docker SILENTLY used the
legacy builder and failed 20 steps deep; BuildKit env; colima sized from
host CPUs (api service reserves >2).

### Uncommitted
`?? src/mind/gsearch.js` and `?? scripts/gsearch-setup.js` are UNTRACKED.
`M TODO.md src/agent.js src/prompts.js src/pty_session.js`.
Suggest committing the verified pieces (gsearch module, setup script,
prompts) SEPARATELY from `agent.js`, which carries the P0 bug.

### P1 — agent.js edit fragility
Repeated mid-file surgical edits corrupted `agent.js` before. Prefer
**full-function rewrites**, and always `node --check src/agent.js` (and
`src/pty_session.js`) before commit — every fix above was also verified
live against a real PTY (see git history / ask for the smoke-test pattern),
not just syntax-checked.

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
