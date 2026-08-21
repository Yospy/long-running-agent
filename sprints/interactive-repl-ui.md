# Sprint: interactive REPL UI

Status: implemented, live-tested, neutral subagent review complete with all findings fixed and
re-verified. Additive feature on top of the existing autonomous single-shot mode — did not modify
its behavior (`loop/run.ts`'s own logic is untouched; only three constants gained an `export`
keyword for reuse).

## Neutral review findings (all fixed)

The reviewer independently live-tested the actual CLI (same pty method) rather than trusting
claims, and reproduced three real bugs against the running code:

1. **Ctrl+C hung indefinitely instead of ending the session.** `rl.close()` alone never settles
   a pending `readline/promises` `question()` — only a `"line"` event or an aborted `AbortSignal`
   does. Reproduced: the process only died via Node's own unsettled-top-level-await watchdog,
   contradicting the on-screen "press Ctrl+C to end the session" instruction. Fixed with the
   documented `AbortController`/`signal` pattern. Re-verified live: clean exit, code 0, ~1s.
2. **`boxTextLine()` measured/padded already-styled text**, so any line styled before being
   passed in (the banner title, the compaction block's header and merged-turns line) rendered
   short by however many invisible ANSI bytes the style added — misaligning exactly the banner
   shown at every session start and the compaction block, one of the two things this whole
   feature exists to show clearly. Fixed by padding on the plain text first, styling the padded
   result after. Re-verified live in a real TTY (styleText is a no-op outside one, so this had to
   be checked against real ANSI codes, not just unit tests): borders now align exactly.
3. **`runInteractive()` had no top-level catch**, unlike `runAutonomous()` — an exception
   escaping `session.ts`'s own handling would propagate as a raw, unfriendly stack trace instead
   of the same clean error message the autonomous mode gives (confirmed `unhandledRejection`
   doesn't catch a directly-awaited rejection). Fixed by mirroring `runAutonomous`'s try/catch.

Also acted on as part of the same pass, even though not strictly "bugs":
- Extracted the pure rendering functions (`boxTextLine`, `horizontalRule`, the context gauge, the
  compaction block, tool-call labels) into `src/cli/render.ts` — `cli.ts` itself can't be
  imported by a test file without triggering its own `program.parseAsync()`, so this was
  previously untestable. New `tests/render.test.ts` (13 cases) directly protects against the
  padding bug recurring, by asserting the truncation/padding decision doesn't depend on which
  style is requested — the actual contract the fix relies on.
- Added the three test cases the reviewer flagged as live-tested-but-not-unit-tested: per-turn
  iteration cap, compaction failure mid-turn, and tactical-stall recovery within a turn.
- Reviewed and confirmed sound, no changes needed: compaction ordering (never discards in-flight
  tool calls, same structure as `run.ts`), per-turn stall-detection reset semantics, tool-error
  handling, and the exported-constant reuse from `run.ts` (semantics genuinely match; confirmed
  no logic in that file changed).

Final: 82/82 tests pass (was 66 going into review), typecheck clean.

## Implementation notes (post-build)

- `loop/session.ts` (`runInteractiveSession`), `loop/systemPrompt.ts` (`INTERACTIVE_SYSTEM_PROMPT`,
  additive), `cli.ts` rewritten for the optional `[goal]` argument + interactive rendering layer,
  `tests/session.test.ts` (10 cases) + `tests/client.test.ts` (6 cases, added while extracting
  `buildRequest()` for testability). 66/66 tests pass, typecheck clean.
- Real bugs found only by live-testing (a pty-based test harness, since piped/non-TTY stdin
  hides real terminal-echo/buffering behavior — see below), each fixed and re-verified live:
  1. `onCompaction`'s callback didn't actually carry the archive pointer, but the `cli.ts` call
     site referenced one anyway (passed `session.runDir` as a stand-in) — caught before it ever
     ran, by re-reading my own wiring. Fixed by adding `archivePointer` to the callback signature.
  2. The interactive session never wired `onStreamEvent` into its own `generateWithRetry` call —
     during any real API round-trip (which can run tens of seconds with adaptive thinking), the
     screen would show nothing at all. Fixed by threading `onStreamEvent` through
     `InteractiveSessionParams` and wiring a dedicated `renderInteractiveStreamEvent` in `cli.ts`
     (text/thinking deltas only — `tool_use_start` is deliberately dropped there, since the
     separate `onToolCall` callback already announces each call once, richly, avoiding a
     duplicate bare announcement).
  3. Once streaming was live, structural lines (the context gauge, tool-call announcements,
     compaction blocks) could end up printed directly onto the end of raw streamed text with no
     line break, since `text_delta` writes have no guaranteed trailing newline. Fixed generally,
     not case-by-case: one shared `interactiveAtLineStart` flag in `cli.ts`, checked by every
     structural print, rather than sprinkling ad-hoc leading `\n`s (the class of bug the plan's
     own risk section flagged as easy to introduce piecemeal).
  4. `onTurnResponse` printed the model's full final text again even when streaming had already
     shown it live — the same double-display class of bug caught earlier in the autonomous mode's
     UX pass. Fixed with the same pattern: guarded on `!params.onStreamEvent`.
- A pty-based live test (Python's stdlib `pty` module, used only for testing — not a project
  dependency) with an intentionally extreme `--compaction-budget 500` forced five compactions
  within a single turn. Confirmed: the compaction block renders the real merged `context.md`
  content correctly every time; tactical stall detection (3 identical consecutive tool calls)
  correctly persists across compaction boundaries within a turn and successfully broke a
  redundant-verification loop the model fell into under that unrealistically tight budget.
- Monochrome palette applied tool-wide, not just to the new interactive mode: `renderEvent`
  (subagent status lines, used by both modes) and `renderStreamEvent` (autonomous mode's own
  streaming) were already close to this but had their coloring reviewed for consistency; `red` is
  the one deliberate exception, reserved for actual errors.

## 1. Scope

Add a second, interactive front-end to the existing agent harness: a persistent terminal
session where the user types a message into an input box, presses Enter, watches the agent
work (tool calls, subagent activity, live context-window usage, compaction), gets a response,
and the input box returns for the next message — in the same ongoing session, like Claude
Code's own CLI.

**Non-goals:**
- Not touching `loop/run.ts` (`runAgentLoop`) or its checkpoint/compaction/completion-check
  behavior. That path is already built, live-verified across multiple runs, and is what the
  graded demo video will use. Zero regression risk to it.
- Not a pixel-perfect clone of Claude Code's own (ink/React-based) rendering engine. Same
  information — input box, live tool calls, context gauge, compaction display — via hand-rolled
  ANSI + `node:readline`, consistent with this project's existing no-framework approach (already
  used `node:util`'s `styleText` over `chalk` for the same reason).
- Not real multi-session persistence (saving/resuming a chat across process restarts) — a
  session lives for one process run, matching scope of everything else in this project.

## 2. Why this is a different mode, not a UI skin on the existing one

The autonomous mode's stopping condition is "explicit success criteria met," checked by a
separate `checkCompletion` LLM call after every turn — that's what makes it safe to leave
unattended. An interactive mode's natural stopping point per turn is simply "the model made its
last tool call and is ready to respond" (`toolCalls.length === 0`) — same as how Claude Code
itself works: it works autonomously within a turn, then yields to you. Running `checkCompletion`
after every interactive turn would be wrong (it would keep telling the agent to continue
working toward a goal you haven't stated for this turn). So: new turn-based driver, no
completion-check phase, human decides when they're satisfied — but it reuses every lower-level
primitive already built (context assembly, `shouldCompact`/`compact`, `ToolRegistry.dispatch`,
`routeToolOutput`, checkpoint logging, stall detection).

## 3. Architecture decisions

- **New file, not a refactor of `run.ts`**: `src/loop/session.ts` exports `runInteractiveSession`.
  Structurally parallel to `runAgentLoop`'s inner loop (planning → executing_tool → compacting)
  but wrapped in an outer "wait for input → run one turn → print response → wait again" cycle,
  with no `validating_completion` phase.
- **CLI entry point**: `<goal>` argument becomes optional in `cli.ts`. Given → today's unchanged
  autonomous single-shot run. Omitted → launches the interactive session. Same process, same
  flags otherwise (`--compaction-budget`, `--effort`, etc. all still apply).
- **Session continuity**: first message runs the existing one-shot `runIntake` to seed goal.md
  (keeps the benefit of that clarification step). Every message after that — including the
  first — is pushed into the buffer as a new user turn; no re-running intake. The agent sees the
  accumulated context (goal.md + context.md + buffer) exactly as it does today; a follow-up that
  changes direction is handled by the model's own judgment, not special-cased.
- **Per-turn safety net**: same tactical/strategic stall detection as the autonomous loop, scoped
  to one turn, plus a per-turn iteration cap (default 30) so a turn can't run forever without
  ever handing back to the user.
- **Context gauge**: after every `generate()` call, compute `inputTokens + cacheReadInputTokens +
  cacheCreationInputTokens` (the exact formula `shouldCompact` already uses) and print an updated
  `Context [████░░░] N / budget tokens` line. Simplification vs. a true pinned status bar: printed
  as a fresh line each time rather than redrawn in place — avoids fragile ANSI cursor-region math
  that's an easy way to corrupt terminal output. Upgradeable later if wanted.
- **Compaction display**: when `compact()` fires, print a bordered block with the merge stats
  (turns merged, archive pointer) *and* the actual resulting `context.md` text — full transparency
  into the one mechanism this whole project exists to prove, not just a "compacting..." spinner.
- **Tool-call detail**: each tool announcement shows name + its most relevant input field
  (`Write(src/db.js)`, `Bash(npm test)`, `Read(package.json)`) instead of a bare tool name.
  Small formatting helper, one line per tool.
- **Input handling**: `node:readline/promises` for the prompt loop — built into Node, no new
  dependency, sufficient for "type a line, press Enter."

## 4. Target UI

```
╭──────────────────────────────────────────────────────────────────╮
│  Rocket Agent — interactive session                               │
╰──────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────╮
│ >  Build a bookmark manager REST API with 4 CRUD endpoints        │
╰──────────────────────────────────────────────────────────────────╯

Context  [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]      0 / 12,000 tokens

⏺ list_dir(.)
⏺ Bash(npm init -y)

  Setting up the shared database module first so the
  subagents can depend on it...

⏺ Write(src/db.js)

Context  [████████░░░░░░░░░░░░░░░░░░░░]  3,240 / 12,000 tokens

⏺ Dispatch(4 subagents: create, list, delete, search)

  [create-endpoint] Implementing POST /bookmarks handler...
  [list-endpoint]   Implementing GET /bookmarks handler...
  [delete-endpoint] Implementing DELETE /bookmarks/:id handler...
  [search-endpoint] Implementing GET /bookmarks/search handler...

Context  [████████████████████░░░░░░░]  9,850 / 12,000 tokens

⏺ Write(src/app.js)
⏺ Bash(npm test)
  ✓ 16 tests passed

Context  [██████████████████████████░]  11,980 / 12,000 tokens

┌─ Compacting context ──────────────────────────────────────────┐
│ 22 turns merged · archived to scratchpad · main:a2246...       │
│                                                                  │
│ ## Goal (restated)                                              │
│ Build a bookmark manager REST API with 4 CRUD endpoints...      │
│                                                                  │
│ ## Constraints and decisions made                                │
│ - Schema: bookmarks(id, url, title, tags, created_at)           │
│ - Route order: /bookmarks/search before /bookmarks/:id          │
│                                                                  │
│ ## Completed steps                                               │
│ - npm project + deps installed                                  │
│ - 4 handlers delegated to 4 subagents, all conforming            │
│ - app.js wired, tests passing (16/16)                           │
│                                                                  │
│ ## Next planned step                                             │
│ Write README.md, final verification pass                        │
└──────────────────────────────────────────────────────────────────┘

Context  [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]      0 / 12,000 tokens

⏺ Write(README.md)
⏺ Bash(npm test)
  ✓ 16 tests passed

  Goal complete. Built a 4-endpoint bookmark manager API
  with full test coverage. See README.md for the contract.

╭──────────────────────────────────────────────────────────────────╮
│ >                                                                   │
╰──────────────────────────────────────────────────────────────────╯
```

## 5. Steps

1. `loop/session.ts` — `runInteractiveSession`: turn loop (no completion-check phase), reusing
   `assembleMessages`/`compact`/`shouldCompact`/`ToolRegistry.dispatch`/`routeToolOutput`/stall
   detection from the existing modules.
2. `cli.ts` — optional `[goal]` argument; branch to the new session driver when omitted; wire
   `node:readline/promises` for the input box.
3. Rendering helpers: context gauge line, bordered compaction block, tool-call detail formatter
   (small, isolated additions — no change to existing `renderEvent`/`renderStreamEvent`, which
   the autonomous mode still uses untouched).
4. Unit tests for `runInteractiveSession` (turn boundaries, stall detection, per-turn cap,
   multi-turn buffer continuity) mirroring the existing `run.test.ts` patterns.
5. Live smoke test: a short interactive session, multiple turns, confirm the gauge/compaction
   display render correctly against real API output.
6. Neutral subagent review, per established practice.

## 6. Risks

- ANSI rendering bugs are easy to introduce and can corrupt terminal output in ways only visible
  live, not in unit tests — mitigated by keeping the gauge as fresh-line-per-update (not
  cursor-redrawn) and testing live before calling this done.
- Scope risk to the graded deliverable: this is not required by the task spec (which asks for
  the autonomous mode + a demo crossing 2+ compaction boundaries — already fully built and
  validated). Recommend finishing the required recorded demo run first, using the existing
  unmodified single-shot mode, so this additive feature can't put the actual deliverable at risk.

## 7. Verification plan

- `tsc --noEmit` clean, new unit tests passing alongside the existing 56.
- Live multi-turn session against the real API, at least one compaction forced, checking the
  gauge and compaction block render correctly and a fact from before the compaction is still
  correctly referenced after it (same continuity proof as the autonomous mode's demo).
- Neutral subagent review before calling it done.

## 8. Redesign — ephemeral status area, elapsed time, boxless (post-launch iteration)

Follow-up round, driven by direct feedback after the first version shipped: the growing list of
every tool call was making sessions unusually long to read, colors needed to be strict black/white
(no "dim" — reads as sketchy gray against a plain black terminal), and the box-drawn look was
replaced with a plainer, bulleted style closer to Claude Code's own terminal rendering (researched
via a dedicated subagent — treated the "no argument shown, tool calls just announce and finish"
claims skeptically since they contradicted directly-observable behavior; kept the
architecturally-reliable parts: streaming pauses during a tool call, subagents don't expose their
own live intermediate steps by default).

**New mechanism — one unified ephemeral status region** (`src/cli/ephemeralRegion.ts`,
`EphemeralRegion`, tested with a fake stream in `tests/ephemeralRegion.test.ts`): a block of N
terminal lines redrawn in place via `node:readline`'s `cursorTo`/`clearLine`/`moveCursor` — no new
dependency. TTY-aware: on a non-TTY (piped/redirected) stream it falls back to plain sequential
lines instead of overwriting, since cursor-control escape codes have no visual meaning there and
would just pollute the output.

Important design correction made *during* this round, before it ever ran live: the original plan
called for two independent ephemeral regions (one for the main job's status, one for subagents).
Caught the flaw on paper — two regions each assuming *they* control the cursor position breaks the
moment they're stacked vertically, since whichever one wrote most recently determines where the
cursor actually is. Consolidated into one region holding the main line plus one line per active
subagent, always redrawn as a whole on any change.

**What the region shows:** an elapsed-time ticker ("Thinking… Ns") while waiting on a generate()
call (`onGenerateStart`, a new hook on `InteractiveSessionParams`), replaced by the current tool
call once one starts (`onToolCall`, already existed), with one line per active subagent
underneath once `dispatch_subagents` runs — each subagent's line updates independently via a new
`onEvent`-routing function, `renderSubagentEvent`, that distinguishes short structured status
updates (intake/tool-call/compacting/retry — collapsed into the region) from a subagent's
substantive final commentary (its own finished-turn report, emitted by the existing per-turn text
surfacing in `loop/run.ts`) — the latter must **not** go through the 100-char-capped ephemeral
region, since that would silently truncate/destroy it; it prints as permanent scrollback instead.

**Bug caught live, not in unit tests:** subagent activity doesn't flow through
`runInteractiveSession`'s own `onEvent` parameter at all — it flows through a *separate* `onEvent`
bound once at `makeDispatchSubagentsTool` construction time in `buildToolRegistries`, shared
by both modes and hardcoded to the old plain-printing `renderEvent`. The new routing was
initially wired into the wrong place and was fully inert — a first live pty run showed subagent
lines still printing as a plain growing list, unchanged. Fixed by making `buildToolRegistries`
take the dispatch tool's `onEvent` as a parameter, so each mode supplies its own (autonomous:
unchanged `renderEvent`; interactive: the new status-routing function).

**End-of-turn summary** (`formatTurnSummary` in `src/cli/render.ts`): replaces the old
per-call-printed context gauge entirely — total elapsed time (`formatElapsed`, "45s" under a
minute, "2m 15s" at or above), a compact per-tool tally (`write_file×2, run_command×1`), and the
latest context-token count, shown once, after the status region clears, instead of a live gauge
line on every generate() call. Verified live: tally matched the real transcript exactly
(`write_file×1, run_command×3`) on a run that also crossed 3 compaction boundaries at an
aggressively low test budget.

**Boxless redesign**: `boxTextLine`/`horizontalRule`/`printBannerLines` removed from
`render.ts` entirely (along with the `boxTextLine` styled-text padding bug found in the prior
review round — moot now, the function no longer exists). Compaction display
(`renderCompactionSummary`) is now a bold header line followed by the indented, actual merged
context.md text, no border characters — verified live across 3 real compactions in one session.

**Color pass**: every remaining `styleText("dim", ...)` call removed project-wide (both
interactive and autonomous-mode renderers, for one consistent look) — plain default text (renders
white on a black terminal) for normal content, `bold` for emphasis, `red` kept as the one
exception for actual errors.

Verified live via a pty-based test harness across three separate runs (a 3-subagent task that
independently hit a real ESM/CommonJS environment conflict — good incidental evidence for the
error-handling story too; a forced-multi-compaction single-file task confirming the boxless
compaction display and the exact turn-summary format).

### Neutral review (post-redesign) — 4 findings, all fixed

Reviewer built its own virtual-terminal emulator to replay the actual ANSI byte stream rather than
trust comments — caught a real bug the live pty testing had *already surfaced but I'd missed while
looking at something else*: the status region never checked the shared `interactiveAtLineStart`
flag before drawing, so unterminated streamed text immediately followed by a tool call squished
onto one line. Visible in my own earlier captured logs once I knew to look for it
(`"I'll check the workspace first, then dispatch the subagents.⏺ run_command(...)"`). Fixed by
injecting a defensive newline only on a *fresh* draw (region not already active) — an active
region's own overwrite must stay untouched, or the in-place update breaks.

Also fixed: a subagent's final-report branch was clearing *all* subagents' tracked status instead
of just the reporting one (data loss for concurrently-running siblings, not just a screen
artifact); tightened the status/commentary routing heuristic to the exact shapes the harness
emits (documented, not fully eliminated, residual risk — closing it fully means marking status
lines explicitly in loop/run.ts, out of proportion for this); deduplicated a trivial helper.
Documented rather than fixed: a few unguarded `checkpointLog.append()` calls inside the turn loop
could, on a genuine I/O failure, skip the turn summary and end the session via the outer catch
instead of returning to the prompt — rare, and the fallback is still a clean error, not silent.

While live re-verifying the line-squish fix, caught one more related legibility issue myself (not
flagged by the reviewer): thinking and answer text ran together with no separator when the model
switched between them mid-stream. Same fix pattern, same guard. Re-verified both live via pty:
clean line breaks throughout. 89/89 tests pass, typecheck clean.

---

## Follow-up: `/goal` command — REPL route into the autonomous loop

**Motivation (caught by a run audit, not a test):** a demo run crossed zero context boundaries
because it ran entirely in interactive mode — turn-based, no completion check, and intake only
on the first message, so goal.md described a "Hello" while the agent built a bookmarks API. The
task spec's deliverable (a goal run crossing ≥2 context-window boundaries) only exists in
`runAgentLoop`, which was unreachable without relaunching with a CLI goal argument — something a
REPL user will never do. The compaction-budget default (25K) was deliberately *not* lowered to
manufacture compactions: goal size, not the budget, is what honestly fills the window twice.

**Semantics:** bare prompt = chat turn (unchanged); `/goal <task>` = autonomous run to
completion on the live session (one run dir, one checkpoint log, same tool registries), then
back to the prompt. No new colors: the typed command already echoes in inverse video; the
launch line and end-of-run stats use the existing orange action channel.

**Implementation:**
- `loop/run.ts` gained optional `onGenerateStart` / `onContextUpdate` / `onCompaction`
  callbacks, wired at the same points session.ts already had them — additive only; subagents
  and the CLI-goal path pass none and behave exactly as before.
- `cli.ts`: `runAgentLoop` wiring extracted into `runGoalWithSession` (shared by the CLI-goal
  path and `/goal`, so the two can't drift); `renderMainJobEvent` routes the main job's event
  lines (status → ephemeral spinner, `tool: X` → permanent orange + tally); `runGoalFromRepl`
  runs the whole flow and always returns to the prompt, including on `AgentError`.
- `loop/session.ts`: the latched `goalSeeded` flag became a per-message goal.md disk check —
  a `/goal` run writes goal.md mid-session, and a stale latch would have re-run chat intake on
  the next message and overwritten that goal (the mirrored version of the original bug).

**Stale-goal guard (the load-bearing detail):** `/goal` clears goal.md + context.md before
starting, because `runAgentLoop`'s intake trusts an existing goal.md (the `--run-id` resume
path). Without the clear, the run's completion check would validate against the chat's
first-message goal — recreating the exact failure this feature exists to fix.

**Verification:** 106/106 tests (new: run.ts callback wiring — counts and argument shapes;
parseGoalCommand cases), typecheck clean. Not yet live-tested end-to-end — the demo run itself
is that test.
