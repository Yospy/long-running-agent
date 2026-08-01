# Sprint: Bounded-Concurrency Subagent Scheduler + Heartbeat Visibility

Status: implemented, tested headless (93/93 tests pass, typecheck clean), not yet live-verified
against the real API.

## Implementation notes (post-build)

- `orchestrator/subagent.ts`: `runDispatchPlan`'s wave-based `Promise.all` loop replaced with a
  bounded worker pool (`inFlight` map capped at `maxConcurrentSubagents`, backed by
  `Promise.race` to pick up whichever subtask settles first and immediately backfill its slot
  from the ready queue). All existing DAG semantics — `dependsOn` ordering/result-folding, cycle
  detection, duplicate-jobId rejection, skip-on-failed-dependency, capped summary report-back,
  retry-once-in-place — are unchanged in behavior and covered by the original 8 tests, which
  pass unmodified against the new scheduler.
- Retry-in-place confirmed as the design: `runSubagentWithRetry` still holds its pool slot for
  both attempts back-to-back, per the earlier discussion (simpler, retries are the uncommon
  case, no evidence yet of workloads where this actually costs meaningful throughput).
- Heartbeat visibility: `onEvent` now fires `[jobId] subagent started`, `subagent queued
  (waiting for a free slot)`, `subagent still running (Ns)` (every 15s while active), and
  `subagent done`/`failed`/`skipped`. Purely observational — no new tool surface for the model,
  no auto-kill on staleness; the existing layered timeouts remain the only enforcement.
- `cli.ts`: new `--max-concurrent-subagents <n>` flag (default `4`), threaded through
  `CliOptions` → `Session` → `SubagentDispatchOptions`.
- **Bug caught before it shipped, not after:** `cli.ts` had been independently reworked (outside
  this sprint) into an ephemeral-status-region interactive renderer since this plan was written —
  `SUBAGENT_STATUS_LINE` (a regex classifying which subagent `onEvent` lines are routine status
  vs. substantive scrollback) didn't recognize any of the new heartbeat line shapes. Left as-is,
  every 15s heartbeat tick from a long-running subagent would have printed as a *permanent*
  scrollback line in interactive mode — spamming exactly what that ephemeral-region redesign
  exists to prevent. Fixed by extending the regex to route `subagent
  (started|queued|still running|done|failed|skipped)` into the ephemeral region, consistent with
  how `intake`/`tool: X`/`compacting`/`validating completion` are already handled.
- Tool description string now interpolates the actual configured cap
  (`` `Up to ${options.maxConcurrentSubagents} run concurrently...` ``) instead of a hardcoded
  claim of unconstrained parallelism, so the orchestrating model's own understanding of the tool
  stays accurate regardless of what `--max-concurrent-subagents` is set to.
- New tests (`tests/subagent.test.ts`, 4 added, 12 total in the file): concurrency never exceeds
  the cap under more ready subtasks than slots (peak-concurrency instrumented client, 6 subtasks
  capped at 2); a freed slot is backfilled before an unrelated slower sibling finishes (proves
  not-wave-locked, via onEvent timestamps: `c-fast`'s start time is asserted strictly before
  `b-slow`'s done time); started/queued/done events fire for the correct jobIds under a cap of 1;
  zero leaked heartbeat timers after all subtasks settle, including through the retry-then-fail
  path (`vi.useFakeTimers()` + `vi.getTimerCount() === 0` post-dispatch).
- Full suite: 93/93 pass (was 82 at sprint-plan time, +11 from this work and other since-diverged
  interactive-UI work), typecheck clean.
- **Not yet done:** a live rerun against the real API with concurrency intentionally forced below
  a real batch's subtask count, to confirm the queuing behavior holds under actual network
  latency and real subagent durations, not just the synthetic delays used in the unit tests.

## Motivation

`dispatch_subagents` (`orchestrator/subagent.ts`) currently fires every dependency-satisfied
subtask in one `Promise.all` per wave, with no cap — 4 ready subtasks run concurrently today
only because the demo goal happens to dispatch exactly 4. A goal that dispatches 10 independent
subtasks would run all 10 at once. Separately, `HeartbeatLedger` already tracks per-job
`status`/`lastHeartbeatAt` accurately (`register`/`heartbeat`/`complete` are all called correctly
from `subagent.ts`), but its only read methods (`get`/`snapshot`) are never called anywhere —
it's write-only bookkeeping today. This sprint makes both real: a genuine bounded worker pool
(default max concurrency 4, configurable) with queuing for overflow, and the existing heartbeat
data surfaced as visible status output instead of sitting unread.

## Scope

- Replace the wave-based `while (remaining) { ready = ...; Promise.all(ready) }` scheduler in
  `runDispatchPlan` with a bounded worker pool: at most N subagents running at any instant
  (default 4). When a running subagent finishes, its slot is immediately backfilled from the
  ready queue — not held until the rest of its original "wave" finishes.
- Preserve all existing DAG semantics exactly, as regression-tested behavior, not just as intent:
  `dependsOn` ordering and result-folding, cycle detection, duplicate-`jobId` rejection,
  skip-on-failed-dependency, capped summary report-back, retry-once-per-subtask.
- Surface `HeartbeatLedger` state as visible output via the existing `onEvent` line channel
  (same mechanism subagent turn-text already goes through) — emit on queued → running →
  done/error transitions, plus a periodic elapsed-time ping for subagents still running past a
  threshold, so a long-running or stuck subagent is visible, not silent.
- Out of scope, deliberately: no auto-kill on staleness. The layered timeouts already in place
  (registry's 90s per-tool ceiling, `dispatch_subagents`'s 30-min safety net, each subagent's own
  `maxIterations` cap) remain the actual enforcement. Heartbeat surfacing here is observability
  only — matches how the ledger was originally scoped, just actually wired up now. Revisit
  auto-kill separately if wanted later.

## Assumptions

- Default max concurrency = 4, overridable via a new `--max-concurrent-subagents` CLI flag,
  mirroring the existing `--subagent-max-iterations` pattern in `cli.ts`.
- "Queue" = in-process FIFO ordered by (dependency-satisfied time, declaration order). Not a
  durable/restart-resumable queue — a queued-but-not-yet-started subtask has the same
  crash-resume gap as the rest of the run today (already a documented, deferred limitation, not
  newly introduced here).
- Heartbeat surfacing is print/log-only through `onEvent`, not a new tool the orchestrator LLM
  can call mid-run — keeps the model's own tool surface unchanged and avoids it spending turns
  polling its own subagents instead of working.

## Steps

1. `orchestrator/subagent.ts`: rewrite `runDispatchPlan`'s core loop as a bounded pool —
   track active-worker count against the configured max; maintain a ready queue; on each
   subtask settling (fulfilled/rejected/skipped), release its slot, recompute which remaining
   subtasks are now dependency-satisfied, enqueue them, and immediately fill any free slot from
   the queue. Keep the existing cycle-detection check (queue empty + no active worker + subtasks
   remaining ⇒ cycle error) adapted to the pool structure.
2. Thread `maxConcurrentSubagents` through `SubagentDispatchOptions` → `cli.ts`'s new
   `--max-concurrent-subagents <n>` option (default `4`) → `buildToolRegistries`.
3. Wire ledger transitions to `onEvent`: emit on enqueue, on start, on a periodic
   heartbeat-interval tick while running (timer per active job, cleared on that job's
   completion — success or failure, no leaks), and on completion — same `[jobId] ...` line
   convention already used elsewhere in `run.ts`/`session.ts`.
4. Tests (`tests/subagent.test.ts`): concurrency actually capped at N when more than N subtasks
   are ready simultaneously; a completing task's slot is backfilled immediately, not wave-
   aligned; existing `dependsOn`/cycle/duplicate-id/skip-on-failed-dependency cases still pass
   unmodified; heartbeat lines emitted on each state transition; timer cleanup on both success
   and failure paths.
5. Live verification: rerun a real goal with more independent subtasks than the concurrency cap
   (e.g. split the bookmark-manager work into 6 subtasks with `--max-concurrent-subagents 4`, or
   reuse the existing 4 endpoints with the cap set to 2) and confirm actual queuing in the
   terminal output and checkpoint log — not just unit tests.

## Risks

- Correctness under *mixed* dependency graphs (diamond-shaped `dependsOn` combined with the
  concurrency cap) is the real complexity — needs explicit test cases beyond the flat-parallel
  happy path already covered today.
- Per-job heartbeat timers must be reliably cleared on every exit path (success, failure, and
  the existing retry-once path creating a second `jobId-retry` job) or they leak across a
  long-running orchestrator process.
- Must not change observed behavior for the existing common case (≤4 independent subtasks,
  today's demo goal) — same results, same effective ordering, just executed through the pool
  instead of one `Promise.all` wave.

## Verification

- All existing `tests/subagent.test.ts` cases pass unmodified.
- New tests cover: >N ready subtasks queue and drain correctly under the cap; a freed slot is
  backfilled immediately rather than waiting on the rest of its original wave; heartbeat events
  fire on every state transition with no leaked timers.
- One live rerun against the real API with concurrency intentionally forced below the number of
  ready subtasks, checkpoint log inspected to confirm correct ordering and zero dropped or
  duplicated subtasks.
