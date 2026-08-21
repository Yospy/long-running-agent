# Sprint: Audit-Evidence Persistence (run manifest, per-compaction snapshots, usage trajectory, run-end record)

Status: implemented, tested, typecheck clean. Not yet live-verified against the real API (see
"Implementation notes" below for why that check was deliberately skipped here).

## Implementation notes (post-build)

- Built exactly as scoped — no deviations. `CheckpointEventType` gained `"usage"`/`"run_end"`
  (additive); `context.md`'s overwrite behavior is untouched, `compactions/NNNN.md` is a parallel
  write; `RunLoopResult`/`RunLoopParams`'s existing shape is untouched — manifest/run-end
  bookkeeping lives entirely in `cli.ts`, using the `onIteration`/`onCompaction` hooks that already
  existed on `RunLoopParams` (previously only used by `orchestrator/subagent.ts`'s heartbeats).
- `run.ts`'s new `usageRecord()` helper is exported and imported by `session.ts` rather than
  duplicated — these two files already cross-import `MUTATING_TOOLS`/`STRATEGIC_STALL_WINDOW`/
  `TACTICAL_STALL_WINDOW`, so this follows an existing precedent rather than inventing a new one.
- `runManifest.ts`'s `summarizeRunUsage` derives compaction count and token totals by reading
  `checkpoint.jsonl` back (filtered to `jobId`), rather than threading a second accumulator through
  `cli.ts` — one source of truth, consistent with `CheckpointLog.open()` already recomputing its
  own `seq` counter from the log instead of trusting external state.
- `AnthropicClient.getConfig()` is a new getter (not an interface change — `ModelClient` is
  untouched) so `cli.ts` records the *actually resolved* model/effort (defaults included) without
  duplicating `DEFAULT_MODEL`/`DEFAULT_EFFORT` a second time.
- Interactive REPL sessions get a manifest/run_end close-out too (not just autonomous/`/goal`
  runs) — `finalStatus: "interactive_session_ended"`, `totalTurns` (from the existing `onTurnEnd`
  hook). A session that runs `/goal` gets *two* `run_end` records for `jobId: "main"` over its
  lifetime (the goal run's own close-out, then the session's) — both are legitimate, distinct
  terminal events for that job, not a duplicate; `run.json`'s final patch correctly reflects
  whichever came last (the session outliving the goal run).
- Tests: extended `compactor.test.ts` (2 new: usage returned on the retry-success path and the
  plain-success path), `run.test.ts` (2 new: ordered snapshot file matches the live `context.md`
  at the moment it was written; usage records appear for both planning calls and the compaction
  merge, in the right order), `session.test.ts` (extended the existing compaction test with the
  same two assertions), new `runManifest.test.ts` (6: write/read round-trip, patch-merges-not-
  replaces, two sequential patches both survive, patch tolerates no prior file,
  `summarizeRunUsage`'s per-jobId isolation and zero-entries case). 115/115 pass (was 106),
  `tsc --noEmit` clean.
- **Live API check deliberately skipped, on purpose, not an oversight:** this repo's own
  convention (see `sprints/bounded-subagent-scheduler.md`'s "not yet live-verified" and
  `interactive-repl-ui.md`'s "intentionally left for the user's demo run") is to leave real-API
  smoke tests to the user rather than spend their API budget on verification the mocked-client
  test suite already exercises path-for-path. Confirmed instead that `tsx src/cli.ts --help` loads
  cleanly (no import/runtime errors from the new module). Recommended manual check, cheap and
  non-destructive: a short goal with a low `--compaction-budget` in a scratch `--run-id`, then
  inspect the resulting `run.json`, `compactions/*.md`, and the `usage`/`run_end` entries in
  `checkpoint.jsonl` by hand.
- **Deliberately deferred (documented in the approach doc's §6, not fixed here):** assistant
  reasoning text between tool calls isn't checkpointed (only streamed live to the terminal, and
  archived as part of a compacted buffer); intake's raw model response is discarded once parsed
  into `goal.md`. Agreed with the user up front to keep this change purely additive.

## Motivation

A prior audit (transcript reviewed and independently verified against this codebase, file:line)
found the append-only spine (`checkpoint.jsonl` + scratchpad archives) is solid — no goal-relevant
data is ever silently lost — but a run directory alone can't answer three evidence questions an
eval/demo needs:

1. What configuration produced this run? (`cli.ts`'s `setUpSession` prints model/effort/budget/
   flags to the console but never persists them — no `run.json` anywhere.)
2. What did each compaction boundary actually carry forward? (`context.md` is overwritten every
   compaction — `contextWindow.ts:writeContext` is a bare `writeFile` — so only the *last* of N
   merged summaries survives as a file; verified on disk: two real runs each show exactly 2
   `compaction` records in `checkpoint.jsonl` but only 1 `context.md`.)
3. Did the context window actually climb and reset twice? (`lastUsage` in `run.ts`/`session.ts` is
   a local variable, reset to `undefined` after each compaction, never checkpointed — confirmed by
   `checkpointLog.ts`'s `CheckpointEventType` union having no usage-shaped entry.)

A fourth, cheap gap: the append-only log never records a terminal outcome for the run as a whole —
only per-cause `error` records (`budgetExceeded`, `refusal`, `stall`, `truncated`) or, on success,
nothing at all.

This sprint closes exactly those four gaps. Two smaller gaps from the same audit — assistant
reasoning text not checkpointed, and intake's raw response being discarded after parsing — are
**deliberately deferred** (agreed with the user) and will be documented as known limitations in
the approach doc rather than fixed here, to keep this change additive and low-risk.

## Explicit non-goals (read this before touching anything)

- **No change to agent behavior.** Compaction trigger logic (`shouldCompact`), the state machine,
  stall detection, tool dispatch, and the locked demo parameters
  (`--compaction-budget 12000 --max-iterations 45 --subagent-max-iterations 15 --effort medium`,
  per `sprints/agent-architecture-approach.md` §4.13) are untouched. This is purely additive
  persistence around the existing loop.
- **No cost/pricing estimate.** Token *counts* are persisted; no `$` figure, since there's no
  verified pricing table in the codebase and a guessed one would be worse than nothing.
- **No per-subagent `run.json`.** The manifest is scoped to the top-level run dir only — subagents
  inherit the parent's client config, and their own `jobs/<jobId>/` dirs are sub-resources of the
  same run, not independent runs.
- **No breaking change to `CheckpointEntry`/`RunLoopResult` consumers.** New checkpoint event types
  are additive to the existing union; `run.ts`'s public return shape (`RunLoopResult`) is not
  touched at all — manifest/run-end bookkeeping is done in `cli.ts` using `onIteration`/
  `onCompaction`, hooks that already exist on `RunLoopParams` and are already used by
  `orchestrator/subagent.ts` for heartbeats, just not yet by `cli.ts`.

## Scope (the 4 fixes)

### 1. Run manifest — `runDir/run.json`

New module `src/context/runManifest.ts`: `writeRunManifest` (initial write) and
`updateRunManifest` (read-merge-write patch). Written at session setup in `cli.ts` with
`runId, createdAt, mode, model, effort, compactionBudgetTokens, maxIterations(PerTurn),
subagentMaxIterations, maxConcurrentSubagents, rocketVersion, nodeVersion`. `model`/`effort` come
from a new `AnthropicClient.getConfig()` getter (avoids duplicating `DEFAULT_MODEL`/`DEFAULT_EFFORT`
resolution logic a second time in `cli.ts`) — called on the concrete `AnthropicClient`, no change
to the `ModelClient` interface other code/tests depend on.

Patched at every terminal point a run already has:
- `runGoalWithSession` (shared by CLI-goal and REPL `/goal` — the one place both paths funnel
  through): on success and on the caught-then-rethrown error path alike, patch `endedAt,
  durationMs, finalStatus, iterationsUsed, compactionCount` plus usage totals (see #3).
- `runInteractive`'s session-exit path: patch `endedAt, durationMs, finalStatus
  ("interactive_session_ended" | "error"), compactionCount, totalTurns` when the REPL itself ends
  (covers chat-only sessions that never ran `/goal`).

### 2. Per-compaction context snapshots — `runDir/compactions/NNNN.md`

`contextWindow.ts` gains `writeCompactionSnapshot(runDir, index, contextMd)`. Called from both
`run.ts` and `session.ts` right alongside the existing `writeContext(runDir, contextMd)` call —
`writeContext`'s overwrite behavior is **unchanged** (still the fast-path read for the next
planning call), the snapshot is a parallel, ordered, never-overwritten copy. The snapshot's
relative path is added as `contextSnapshot` on the existing `compaction` checkpoint payload
(alongside `mergedTurns`/`archivePointer`) — no separate index file; `checkpoint.jsonl` stays the
single source of truth for ordering, same as everywhere else in this design.

### 3. Usage trajectory — new `usage` checkpoint record

`CheckpointEventType` gains `"usage"`. Appended in `run.ts` and `session.ts` right after
`lastUsage = result.usage` (planning calls) and after a successful `compact()` call (merge calls) —
`compactor.ts`'s `CompactionResult` gains a `usage: GenerateUsage` field (the SDK already returns
it on every call; `compact()` was just discarding it). Payload: `{phase: "planning" |
"compaction", inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
totalPromptTokens, budgetTokens}`. This is what makes "climbed to 25K, reset, climbed again"
inspectable from `checkpoint.jsonl` alone, not just live terminal output.

Run-manifest token totals (#1) are derived by reading these back
(`checkpointLog.readAll()` filtered to `jobId === "main" && type === "usage"`, summed) rather than
threaded through a second accumulator — one source of truth, consistent with how
`CheckpointLog.open()` already recomputes its own `seq` counter from the log instead of trusting
external state.

### 4. Run-end record — new `run_end` checkpoint type

`CheckpointEventType` gains `"run_end"`. Appended at the same two `cli.ts` points as the manifest
patch (`runGoalWithSession`'s success/catch, and `runInteractive`'s session-exit): `{status,
durationMs, iterationsUsed, compactionCount}`. Closes the append-only log's own story definitively,
independent of `run.json` (belt-and-suspenders: the log is evidence even if `run.json` were ever
lost or a reader only trusts the JSONL).

## Files touched

- `src/context/checkpointLog.ts` — extend `CheckpointEventType` union (2 new variants only).
- `src/context/contextWindow.ts` — add `writeCompactionSnapshot`.
- `src/context/runManifest.ts` — **new file**.
- `src/context/compactor.ts` — `CompactionResult` gains `usage`.
- `src/model/client.ts` — `AnthropicClient.getConfig()` getter.
- `src/loop/run.ts` — write snapshot + `usage` checkpoint records at the two generate call sites.
- `src/loop/session.ts` — same, mirroring `run.ts` (these two files already duplicate this exact
  pattern; kept in sync deliberately, as the codebase already does).
- `src/cli.ts` — write initial manifest in `setUpSession`; patch manifest + append `run_end` in
  `runGoalWithSession` and at REPL session-exit.
- Tests: extend `compactor.test.ts`, `run.test.ts`, `session.test.ts`; new `runManifest.test.ts`.
- `sprints/agent-architecture-approach.md` §6 — one new gap-filled bullet; §9 file layout gains
  `runManifest.ts`.

## Verification

- `npm run typecheck` clean.
- `npm test` — all existing tests still pass unmodified in intent (only additive assertions), plus
  new coverage for: usage records appear per planning + compaction call; compaction snapshot file
  exists on disk with the right content; manifest read/write/merge round-trips; manifest end-state
  reflects success vs. thrown-error paths.
- Diff review: confirm no existing behavior path (compaction trigger, stall detection, error
  taxonomy, tool dispatch) changed — only new writes alongside them.
- Manual: run the CLI briefly (short goal, low budget) and inspect the resulting `run.json`,
  `compactions/*.md`, and `usage`/`run_end` entries in `checkpoint.jsonl` by hand.
