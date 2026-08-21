# Approach — Infinite-Running Agent

Design locked before implementation started (sections 1–5, 9). Phase 1 (core backend) is now
built, tested, and independently reviewed — see §4.10 for what that review changed and what
Phase 2 (terminal UI + wiring) adds on top. This file is the working design doc; it becomes the
final Approach document deliverable once the demo run has actually happened (§8).

## 1. Scope

Build an agent that runs a single goal to completion using Claude, surviving an
arbitrary number of context-window boundaries without losing goal-relevant
information — proven via a coding-task demo that crosses the boundary at least twice.

## 1.1 Stack — FINALIZED

- **Language/runtime: TypeScript on Node.js (LTS).** No agent framework
  (LangGraph.js, Vercel AI SDK, Mastra, etc.) — hand-rolled state machine,
  orchestrator, and context manager on the raw `@anthropic-ai/sdk`. This is a
  deliberate signal, not a shortcut skipped: the evaluation criteria are "system
  design — are boundaries clean and extensible" and "code quality — clear
  boundaries, navigable by someone unfamiliar." A framework would hide the exact
  thing being graded behind someone else's abstraction. Building it from
  primitives is what actually proves the design, not a library's design.
- Minimal, single-purpose dependencies only: `@anthropic-ai/sdk` (the model
  client, not a framework), `commander` (CLI arg parsing), `dotenv` (already in
  use), `zod` (tool input/output schema validation — feeds directly into the
  schema-validate-before-execute error handling in 4.7), `vitest` (tests).
- **Model client is behind an interface, not called directly.** `ModelClient.
  generate({systemPrompt, tools, messages}) → {content, toolCalls, usage,
  stopReason}` — a generic shape, not Anthropic's wire format. `AnthropicClient`
  is the one implementation, and it owns translating our internal representation
  into Anthropic's actual request/response shape, including `cache_control`
  breakpoints on the stable prefix. The loop, orchestrator, and context manager
  depend only on the interface — `@anthropic-ai/sdk` is imported nowhere else in
  the codebase. Swapping providers later = one new file + one line of wiring;
  the harness itself never changes. Not building a second implementation now —
  nothing requires it, that would be scope creep, not design proof.
- **Repo:** `Rocket/` is now its own independent git repository (`git init` run),
  separate from the unrelated, messy parent `~/Desktop` repo.

## 2. Assumptions

- Single Anthropic API key, single model provider used at runtime. But the harness
  depends on a `ModelClient` interface, not the SDK directly — see 1.1 — so this
  is "one implementation," not "no abstraction." Building a second real provider
  implementation is explicitly out of scope; nothing requires it.
- Single-process, single-machine execution. No distributed orchestration infra
  (Temporal, message queues) — the *patterns* are borrowed, not the infrastructure.
- No UI required. CLI/programmatic entry point is enough to demonstrate the architecture.
- Concurrency and timeout *tuning* (pool sizes, exact deadlines) explicitly deferred —
  the mechanism (heartbeat ledger, retry-once) is built now; the numbers get tuned later.
- Long-term/cross-run memory (knowledge spanning multiple separate goals) is out of
  scope. Only this run's continuity matters for the deliverable.

## 3. Core principle

Context window is a cache. Disk is the source of truth. The loop is bounded by
goal-state and progress — never by context size, never by wall-clock time.

## 4. Architecture decisions

### 4.1 State machine

One discriminated union, one loop shape, reused recursively for the orchestrator
and every subagent:

```
intake (once, pre-loop)
  → planning | executing_tool | awaiting_subagent | compacting
  → validating_completion | error | done
```

### 4.2 Intake (pre-loop, one-shot, non-blocking)

- Goal arrives once, turn 1.
- Blocking ambiguity → batch every question into ONE message, ask once. Don't wait —
  proceed immediately on logged best-effort assumptions. A late reply is incorporated
  as a correction, never as a blocking prerequisite (the agent is meant to run unattended).
- Output: `goal.md` seeded with the goal + assumptions + **explicit success criteria** —
  this is what `validating_completion` checks against for the rest of the run.

### 4.3 Context management

**In-context, every turn — 4 layers:**
1. System prompt — static, byte-identical every call (required for cache hits).
2. `goal.md` — agent-maintained, cheap continuous edits, recited every planning step.
3. `context.md` — compaction-maintained rolling summary (goal restated / constraints
   & decisions made / unresolved errors / completed steps / next planned step).
   **Merged, not appended** on every compaction — stays roughly constant size no
   matter how many compactions happen over the run.
4. Recent raw turn buffer — verbatim conversation since the last compaction.

**On disk — 2 stores:**
- **Checkpoint log** — append-only JSONL, ordered, tagged by job id (whole run
  reconstructs as a tree). Every state transition, tool call, tool result,
  compaction event gets one line. Small values inline; large values → pointer.
- **Scratchpad** — the actual bytes those pointers reference, namespaced per job.

**Tool-result routing (size-based, not blanket):**
- Below ~500 tokens → straight into context, no scratchpad involved.
- Above threshold → full content to scratchpad immediately, an auto-generated short
  summary + pointer goes into context right away. Model fetches the raw file back
  only if it specifically needs exact detail later — not a mandatory round-trip.

**Compaction:**
- Trigger: a configurable token budget, decoupled from the model's real max context
  (Claude's real ceiling is far larger). Production default ~150-200K.
  **Demo value: FINALIZED at 25K.** Worth one quick sanity check once code exists —
  confirm 25K takes a real double-digit number of steps to reach on the bookmark-
  manager task, not 2-3 messages, so the crossing reads as earned rather than rigged.
- Algorithm: write raw buffer → checkpoint log (immutable) → merge into new
  `context.md` via the fixed template → rebuild context = prefix + goal.md +
  new context.md + empty buffer → resume `planning`. Self-triggered, same process,
  same run — no external actor, no interruption.

### 4.4 Orchestrator + subagents + heartbeats

- `Map<jobId, {status, lastHeartbeatAt}>` ledger on the orchestrator.
- Subagent = same loop, narrower explicit objective (vague scope caused duplicate
  work in Anthropic's own multi-agent research system — designing against that),
  own scratchpad namespace, stamps heartbeat every completed iteration.
- Stale heartbeat → retry once from last checkpoint → still stale → `error`,
  surfaced, never silently dropped.
- Subagent reports a capped summary (~1-2K tokens) + scratch pointers back to the
  orchestrator, never its full transcript — this is what keeps the orchestrator's
  own context small by construction (prevention). Compaction (recovery) still
  exists at both tiers for when a subtask genuinely runs long.
- **Trigger point — FINALIZED:** the bookmark-manager task decomposes into 4 CRUD
  endpoints (create/list/delete/search). The orchestrator dispatches one subagent
  per endpoint — narrow, explicit objective: implement the handler + its tests
  for that one endpoint, nothing else. Genuine parallel work, not a forced fit —
  exercises the heartbeat ledger with multiple concurrent jobs at once, and the
  narrow per-subagent scope is what avoids duplicate/overlapping work. The
  top-level loop handles intake, wiring the merged endpoints together, running
  the full suite, and fixing cross-cutting failures itself.

### 4.5 Completion

`validating_completion` is a separate check against the explicit criteria set at
intake. The generating step never self-certifies "done."

### 4.6 Progress-based loop bounding (not time-based)

- Tactical stall: hash of last N tool calls, 3 identical → force replan.
- Strategic stall: N consecutive planning cycles with zero net advancement in
  `goal.md`'s plan → broader forced replan → still stuck → `error`/blocked.
- Micro-level timeouts (a single tool call hanging, a subagent heartbeat miss)
  still exist — different concern, detecting one hung step, not capping the run.

### 4.7 Error handling

- Every tool call: schema-validate input → execute under a hard timeout (SIGTERM,
  grace period, then SIGKILL) → schema-validate output → any failure caught and
  fed back into context as a structured error (loop never crashes) + logged to
  the checkpoint.
- Idempotency key = `runId:stepIndex` on every side-effecting call — never
  timestamp or random UUID.
- Budget/iteration hard cap enforced by the orchestrator itself, outside model
  control — a real circuit breaker, not something the model can talk itself out of.

### 4.8 Interface

Terminal-based, streaming — same shape as Claude Code / Codex CLI, not a UI. Goal
passed as an argument or first prompt; output streams tool calls, reasoning
summaries, diffs, test output, and explicit state-transition lines
(`planning`, `compacting`, `validating_completion`, ...) live. Chosen specifically
because it makes the two required context-boundary crossings provable on camera —
a compaction event just prints, with the checkpoint write happening in the open,
rather than being hidden behind a polished chat UI.

### 4.9 Tools

**Core loop tools (do the work) — set for the coding use case:**
- `read_file(path)`, `write_file(path, content)` / `edit_file(path, patch)`
- `list_dir(path)`, `search(pattern, path)`
- `run_command(cmd)` — wrapped in the hard-timeout (SIGTERM → grace → SIGKILL)

**Control-flow tools (manage context/flow, not "the work"):**
- `read_scratchpad(pointer)` — explicit fetch-back when a summary isn't enough;
  a real tool call because only the model knows when it needs the raw detail.
- `request_human_input(question)` — rare escape hatch for genuine blockers
  (missing credential, needs authorization it doesn't have). Not for routine
  ambiguity — that's resolved by the agent's own judgment + a logged assumption,
  same as intake. Frequent use of this tool is a scoping smell, not normal behavior.

**Deliberately not tools:** writing to scratchpad (automatic, size-based,
orchestrator-side) and updating `goal.md` (applied as a side effect of the
planning step's structured output). Making either a separate tool call would
just add round-trips for no benefit.

**User input — two distinct mechanisms, not merged:**
- Intake: automatic, once, before the loop, non-blocking.
- `request_human_input`: manual, model-invoked, mid-run, rare. Shares the
  underlying "write to checkpoint, pause without crashing" pattern, but
  conceptually and operationally distinct from intake.

### 4.10 Implementation status & refinements (post-Phase-1 review)

**Built, tested (16 vitest cases across state/scratchpad/compactor/registry/fileTools/run),
typechecked, and independently reviewed by a neutral subagent:** every module in the §9 file
layout except `cli.ts`. The review changed three real things: `compact()`/`checkCompletion()`/
`runIntake()` calls in the loop were uncaught-crash paths, now all degrade gracefully; strategic
stall detection reset on *any* successful tool call (a model cycling through read-only calls
could stall silently for the whole iteration budget) — fixed to require a *mutating* tool call as
evidence of progress; `makeIdempotencyKey` and 3 `ErrorKind` values were dead code (no
retry-of-a-single-call mechanism exists to make idempotency keys meaningful yet) — removed
rather than kept "just in case."

**Refinements decided while designing Phase 2** (extend, not contradict, §4.1–4.9):

- **Workspace vs. run directory — a split the original design didn't call out.**
  `runs/<runId>/workspace/` is what the agent's file tools and `run_command` operate on (the
  project being built). `runs/<runId>/` itself is the durable audit trail — `checkpoint.jsonl`,
  `goal.md`, `context.md`, `scratchpad/`. Same physical parent, disjoint purposes: one is
  agent-created work product, the other is what proves continuity happened. Subagents get their
  own `runDir` (own checkpoint/goal namespace) but share the orchestrator's `workspaceRoot` —
  they're editing different files of the same project.
- **Full-fidelity compaction, actually.** §7's stated risk mitigation — "nothing is actually
  deleted, only removed from active context" — wasn't fully true: the checkpoint log records
  summarized tool-call/tool-result payloads, not the raw assistant turns verbatim. Fix: at every
  compaction, the full raw pre-compaction buffer is archived to the scratchpad *before* being
  discarded, with that pointer recorded on the compaction checkpoint entry. The LLM-generated
  `context.md` summary is what the agent recites going forward; the exact original is still one
  pointer away if the summary ever misjudges relevance.
- **Two tool registries, not one.** `dispatch_subagents` is only ever registered into the
  orchestrator's registry, never a subagent's own — that's literally what enforces "one level of
  delegation" from §4.4, by construction rather than by convention.
- **`dispatch_subagents` gets an optional `dependsOn: string[]` per subtask.** Dependents wait for
  their dependencies and get their summaries folded into their own objective before starting —
  one tool call can express parallel, sequential, or mixed dispatch. Not needed by the demo task
  itself (4 independent CRUD endpoints, purely parallel) — added for the "clean, extensible
  boundaries" criterion, since §4.4 only designed for the parallel case.
- **Streaming, added to the model layer.** `GenerateParams` gains an optional, provider-agnostic
  `onStreamEvent` callback; `AnthropicClient` switches to the SDK's streaming call internally and
  forwards generic text/thinking/tool-start deltas through it, while still returning the same
  consolidated `GenerateResult` everything already depends on. `cli.ts` renders those events live
  (Codex/Claude-Code-style terminal output). Reasoning shown is Anthropic's *summarized* thinking
  (`thinking.display: "summarized"`) — the raw chain of thought is never returned by the API, on
  any model.
- **`src/loop/systemPrompt.ts` — the piece §4.8 assumed but never authored.** The static, cached
  harness system prompt (autonomy contract, when to stop calling tools, when to delegate, when to
  reach for the scratchpad, verify-before-claiming-done) didn't exist as content anywhere; it was
  only ever a pass-through parameter. Being written now as its own file, separate from `cli.ts`'s
  composition-root concerns.
- **Demo run config:** `claude-opus-5`, effort `medium` — kept at medium deliberately even though
  opus-5 was chosen, so the run takes a genuine double-digit number of steps to hit the 25K-token
  compaction budget rather than reaching it in 2–3 turns and looking rigged.
- **Staged verification:** a cheap smoke test (tiny compaction budget, single loop, no subagents)
  runs before the real bookmark-manager + subagent demo, to catch wiring bugs before spending
  real time/tokens on the recorded run.

**Still open:** `cli.ts` itself (composition root — builds both registries, opens the checkpoint
log/scratchpad, wires the system prompt, parses CLI flags, renders streaming output), then the
staged runs, then the demo video / finalized approach doc / use-case list from §8.

### 4.11 Phase 2 built: streaming, `cli.ts`, `dependsOn` — and a severe bug caught by actually running it

All of §4.10's "still open" items are now built: `src/loop/systemPrompt.ts` (the static harness
prompt), streaming (`StreamEvent` + `onStreamEvent` on `GenerateParams`, `AnthropicClient`
switched to the SDK's `.stream()` internally, still returns the same `GenerateResult`), the
compaction-archival fix, `dependsOn` on `dispatch_subagents`, and `src/cli.ts` wiring everything
together. Two rounds of live verification against the real API, plus a neutral review pass,
surfaced real bugs no amount of unit testing or code reading would have caught on their own:

- **Severe, caught by a live run:** `checkCompletion` only ever saw `goalMd` + `contextMd` —
  but `contextMd` stays empty until the first compaction. Any run judged before crossing that
  boundary (i.e. every short run, and the first stretch of every long one) was being checked
  against zero evidence of work done, so it could never pass. A live smoke test hung in exactly
  this loop before the fix — the checker now also receives the raw pre-compaction buffer.
  `renderTranscript` was extracted from `compactor.ts` into `contextWindow.ts` so both the
  compaction prompt and the completion-check prompt share one renderer.
- **Real, caught by a live overload:** errors that arrive as an in-band SSE `event: error` (the
  request already returned 200 before the server signals an error — exactly how `overloaded_error`
  streams back) were being built by the SDK as a bare `APIError` with `status` forced to
  `undefined`. Recoverability is now classified primarily by `error.type`
  (`rate_limit_error`/`overloaded_error`/`api_error` → recoverable), not status alone. A second
  finding, from an independent review, added `APIUserAbortError` (what our own request timeout
  throws mid-stream) to the same recoverable bucket — the only abort source in this codebase is
  that timeout, so it's a hung-request signal, not a fatal one.
- **`AgentError.recoverable` was computed but never acted on.** All four LLM call sites
  (`loop/run.ts` main planning call, `compactor.ts`, `completion.ts`, `intake.ts`) now go through
  one shared `generateWithRetry` (`model/client.ts`, provider-agnostic) instead of calling
  `client.generate()` directly. Tuned to 5 attempts / linear backoff (2s,4s,6s,8s) against a real
  observed `overloaded_error` that outlasted 3 attempts (~23s) during verification — evidence-based,
  not a blind guess.
- **`dispatch_subagents` didn't reject duplicate `jobId`s** — two subtasks sharing an id silently
  collapsed to one execution with a doubled-up report. Now validated alongside the existing
  dangling-`dependsOn` and cycle checks.

**Known, deliberate limitation, sharpened by review, not newly discovered:** `run_command` only
sets the child process's `cwd` to the workspace root — it is not a real sandbox. A command using
`..`, an absolute path, or a symlink can still reach files outside the workspace, including the
run's own audit trail (`checkpoint.jsonl`/`goal.md`/`context.md`). Real sandboxing (containers,
namespaces, macOS `sandbox-exec`) was already ruled out as disproportionate scope for this
deliverable when `run_command` was first built (§4.9) — the tool description now says so
explicitly, but this remained guidance, not enforcement, until the policy gate below.

### 4.12 Harness-level tool-call policy gate (partial mitigation for the `run_command` gap)

`ToolRegistry.dispatch()` — already the single choke point every tool call passes through,
already validated and timeout-wrapped there — now also accepts an optional `ToolCallPolicy`
(`src/tools/policy.ts`), checked between schema validation and `execute()` for every tool, not
just `run_command`. A denial raises the same `AgentError` shape as any other tool failure, so it's
audited for free — `loop/run.ts` already logs every `tool_call`/`tool_result`, success or error,
for every tool. No new logging plumbing was needed for this.

The concrete policy shipped, `denyKnownDestructiveCommands`, inspects only `run_command`'s
`command` field (every other tool is unconditionally allowed) against a small set of
unambiguously destructive patterns: recursive/force delete targeting a path outside the workspace,
filesystem-format commands, raw disk writes, fork bombs, piping a remote script into a shell, and
`sudo`. Explicitly labeled in its own comment as a tripwire against *accidental* self-inflicted
damage, not real security — string-matching a shell command can always be routed around by a
sufficiently adversarial input, the same limitation as any blocklist. It narrows the §4.11 gap
(catches the realistic "agent runs something destructive by mistake" case, which is the actual
threat model for a personal single-user agent) without pretending to close it (a determined bypass
still isn't stopped) — real enforcement still requires the sandboxing already ruled out as
disproportionate scope. `rm -rf node_modules` (recursive, inside the workspace) is explicitly
allowed — the gate targets *escaping* the workspace, not recursive deletes in general.

Verified: 6 new vitest cases (policy logic in isolation — allow/deny per pattern, run_command-only
scope; and wired through a real `ToolRegistry` — a denial blocks before `execute()` ever runs, an
allowed command still runs normally), plus one live run confirming the gate doesn't interfere with
ordinary tool use.

Verification for this phase: `tsc --noEmit` clean on both configs, 30 vitest cases (up from 22 —
added coverage for `dependsOn` parallel/fold/diamond/cycle/duplicate-id/skip-on-failure, the
archival mechanism, and `generateWithRetry`'s retry/no-retry/exhaustion paths), plus two real runs
against the live API: one confirming the completion-check fix (clean 6-step run, `hello.txt`
created and verified), one forcing compaction (confirmed the boundary triggers correctly, archives
the exact pre-compaction buffer, and doesn't discard the in-flight tool call that was mid-turn
when the budget was hit) before hitting a genuine sustained Anthropic API outage that the retry
mechanism absorbed as designed — attempted, backed off, and failed cleanly and transparently
once truly exhausted, rather than hanging or crashing.

### 4.13 Phase 3 — demo calibration, and the final approach for what's left

**Done.** Removed the unused `better-sqlite3`/`@types/better-sqlite3` from Rocket's own
`package.json` (Phase-0 leftover, zero usage — the demo app installs its own copy inside its
workspace, proving from-scratch capability rather than relying on harness pre-scaffolding). Ran
three live calibration passes of the actual demo task (bookmark-manager API, 4 endpoints delegated
to 4 parallel subagents) against the real API, which found and fixed four real bugs no amount of
code review or unit testing alone would have caught:

1. **Policy false positive** (`tools/policy.ts`) — the destructive-command check ANDed two regexes
   across the *whole* compound shell command instead of the same sub-statement, so an innocuous
   `rm -rf coverage` got denied because an unrelated `curl -o /dev/null` later in the same line
   matched the workspace-escape pattern. Fixed by scoping both checks to the same
   `;`/`&&`/`||`/`&`/`|`-separated sub-statement.
2. **Intake truncation mis-reported as "malformed JSON"** (`loop/intake.ts`) — `maxTokens: 2048`
   with no `stopReason` check; a verbose assumptions/success-criteria list could get cut off
   mid-JSON. Fixed: bumped to 4096, added an explicit `stopReason === "max_tokens"` check.
3. **`dispatch_subagents` starved by the generic tool timeout** (`tools/registry.ts`,
   `orchestrator/subagent.ts`) — the registry's 90s safety-net timeout (sized for a single tool
   call) fired while the dispatched subagents were still correctly completing their work
   underneath it, since `withTimeout` races a timer against the promise without cancelling it —
   silently discarding the structured fulfilled/rejected/skipped contract. Fixed with a per-tool
   `timeoutMs` override on `Tool<TInput>`; `dispatch_subagents` gets 30 minutes (a last-resort net,
   not an operational ceiling — real duration is already bounded by `maxIterationsPerSubagent` and
   each generate call's own retry budget).
4. **The same truncation defect, silently, in `context/compactor.ts`** — found by auditing every
   structured-output call site after finding bug #2 twice. `compact()` has no JSON.parse step, so
   a truncated response would have been *silently accepted* as the new `context.md` — and since
   `## Next planned step` renders last in the compaction template, truncation would drop exactly
   the section most needed to resume. This is the precise silent-data-loss failure mode the whole
   project exists to prevent. Fixed the same way (4096 → 8192, explicit `stopReason` check that
   throws instead of returning partial text). Also applied the identical fix to
   `validation/completion.ts` (1024 → 2048 + the same check), whose absence had, in dry run #3,
   burned an entire subagent's iteration budget on repeated failed completion checks — caught and
   silently recovered by the existing subagent-level retry-once, which is itself a useful,
   unplanned demonstration of the layered-recovery story.

All four fixes are regression-tested (`tests/policy.test.ts`, `tests/intake.test.ts`,
`tests/registry.test.ts`, `tests/compactor.test.ts`, `tests/completion.test.ts` — 44/44 passing,
`tsc --noEmit` clean). A fifth, unrelated latent bug was also caught and fixed along the way:
`npm test` had no `vitest.config.ts`, so it globbed the whole project by default and picked up the
demo app's own Jest-style test files under `runs/**` once a run finally produced any — fixed with
an explicit `exclude`.

**Calibration finding:** the original 25K-token compaction budget never fired once across a full
33-tool-call run of this task — too high a bar for this task size within a sane iteration budget.
Dry runs #2 and #3, both at `--compaction-budget 12000 --max-iterations 45
--subagent-max-iterations 15 --effort medium`, crossed the boundary 2 and 3 times respectively,
both reaching `done` cleanly with a fully passing generated test suite. **These parameters are
locked for the recorded take** — same goal text, same flags, no further tuning planned.

**What's left, and the plan for each:**

- **The recorded run.** Same locked command, run directly in the user's own terminal (not through
  the harness's own tooling) so `cli.ts`'s live streaming — colored thinking/text deltas, tool-call
  announcements, `[jobId] compacting` phase transitions — is visible in real time for the
  recording, with no background-log buffering or foreground timeout constraints in the way.
- **Post-run continuity check.** Once it finishes, inspect `checkpoint.jsonl` for the run: confirm
  ≥2 `compaction` events, and specifically confirm a fact established early (e.g. a schema/contract
  decision from before the first compaction) is still correctly reflected in behavior after both —
  the actual, literal proof of context continuity the task spec asks for, not just "it didn't
  crash."
- **Demo video.** The recording itself, from goal submission through `Goal complete.`, no cuts
  across the compaction boundaries — that continuity is the entire point being demonstrated.
- **Approach document.** This file, lightly edited into deliverable form — the gap-filling (§6),
  risk (§7), and architecture (§4) sections already exist; mainly needs the Phase 3 findings above
  folded into a shorter narrative and the placeholder verification claims in §8 replaced with the
  actual recorded-run evidence.
- **Use-case list.** Ships separately per §5 — the bookmark-manager API is the one fully demoed
  end-to-end; the other listed use cases stay as attempted/considered, not claimed as demoed.

## 5. Use cases

- **Primary, fully demoed — FINALIZED:** multi-file coding task — implement, run
  tests, fix failures, repeat until green. Objective completion check (tests pass
  or they don't). Naturally generates enough tool volume to cross the budget
  twice. This choice determines the tool registry in 4.9.
- **Listed, not fully demoed:** research/synthesis task (multi-source, structured
  report); larger multi-file refactor/migration. Same orchestrator/state-machine/
  context-manager code untouched — swap `run_command`/`edit_file` for
  `web_search`/`web_fetch`, which is the actual proof of use-case agnosticism.
- Bookmark manager's own persistence: SQLite file (`better-sqlite3`), not JSON —
  gives the demo task a real schema/migration/query surface, closer to what
  "production" code looks like than a flat file would.

## 9. File layout (TypeScript, Node LTS)

```
Rocket/
├── task.pdf
├── CLAUDE.md
├── sprints/agent-architecture-approach.md
├── .env / .env.example / .gitignore
├── package.json / tsconfig.json
├── src/
│   ├── cli.ts                  entrypoint — streams to terminal
│   ├── loop/
│   │   ├── state.ts             the union type + transition table
│   │   ├── intake.ts            one-shot clarification phase
│   │   └── run.ts               the main while-loop driver
│   ├── context/
│   │   ├── contextWindow.ts     assembles prefix + goal.md + context.md + buffer
│   │   ├── compactor.ts         threshold check + merge-template compaction
│   │   ├── checkpointLog.ts     append-only JSONL read/write
│   │   ├── runManifest.ts       run.json (config + terminal status), usage/compaction summary
│   │   └── scratchpad.ts        size-based routing, raw file read/write
│   ├── orchestrator/
│   │   ├── ledger.ts            job map + heartbeat tracking
│   │   └── subagent.ts          spawn/dispatch — reuses loop/run.ts
│   ├── tools/
│   │   ├── registry.ts          zod schemas + dispatch
│   │   ├── fileTools.ts         read/write/edit/list/search
│   │   ├── runCommand.ts        shell exec, hard timeout
│   │   ├── scratchpadTools.ts   read_scratchpad
│   │   └── humanInput.ts        request_human_input
│   ├── validation/completion.ts validating_completion vs. success criteria
│   ├── errors/taxonomy.ts       structured error types, idempotency keys
│   └── model/client.ts          Anthropic SDK wrapper, stable-prefix construction
├── runs/                        gitignored — per-run checkpoint log, scratchpad, goal.md/context.md,
│                                 run.json (manifest), compactions/ (per-boundary snapshots)
└── tests/
```

One file per architectural concept already defined above — the folder names
(`loop/`, `context/`, `orchestrator/`, `tools/`) are literally the sections of
this document. That mapping is the point: a stranger reading the tree should be
able to reconstruct the design without reading a word of prose.

## 6. Gaps identified in the spec, and how they were filled

*(explicitly required by the task: "what you noticed was missing from this spec")*

- **What "goal complete" means** — undefined in the spec. Filled with explicit,
  checkable success criteria captured at intake, checked by a separate validation step.
- **Human clarification/intervention** — spec says nothing about it. Filled with a
  bounded, one-shot, non-blocking intake phase — a genuinely unattended/infinite
  agent can't wait indefinitely on a human who may not be present.
- **Non-termination / stuck detection** — spec doesn't address loops that aren't
  making progress. Filled with tactical + strategic stall detection, both
  progress-based, never time-based.
- **Tool/subagent failure mid-run** — spec is silent. Filled with a full failure
  taxonomy mapped to concrete handling: schema validation, timeouts, idempotency
  keys, heartbeat-based retry-once, checkpoint-before-surface.
- **Cost/token runaway** — not mentioned. Filled with a hard budget cap enforced
  outside model control.
- **Concurrency/timeout tuning specifics** — a deliberate, stated deferral, not a
  gap being ignored: the mechanism is built now, exact numbers are a tuning
  exercise beyond what this deliverable needs to prove.
- **Auditability of a run's own evidence trail** — the spec asks for continuity across
  compaction boundaries but says nothing about proving it after the fact. An external audit
  (see `sprints/audit-evidence-persistence.md`) found the no-data-loss spine itself was solid
  (every tool call/result/compaction is durably logged, every pre-compaction buffer archived
  verbatim) but three things a reviewer would want were missing: what configuration produced a
  run (`run.json` manifest, written at setup and patched at every terminal state), what each
  compaction boundary actually carried forward (`context.md` was overwrite-only — only the last
  of N merges survived as a file; fixed with an ordered `compactions/NNNN.md` snapshot per
  boundary), and whether the context window actually climbed and reset (a new `usage`
  checkpoint record per generate call, including the compaction merge itself). A `run_end`
  checkpoint record closes the append-only log's own story definitively. Two smaller findings
  from the same audit — assistant reasoning text between tool calls isn't checkpointed (only
  streamed to the terminal), and intake's raw model response is discarded once parsed into
  `goal.md` — are deliberately **not** fixed, to keep this change additive: both are already
  substantially mitigated (compacted turns' text lives in the scratchpad buffer archive;
  `goal.md` is intake's actual authoritative output) and closing them fully would touch
  already-validated hot paths for a narrower marginal gain.

## 7. Risks

- Structured-template compaction could still misjudge relevance → mitigated by
  the checkpoint log as a full-fidelity fallback (nothing is actually deleted,
  only removed from *active* context).
- A blind-guessed demo threshold could look either trivial (too low) or
  impractically slow (too high) → mitigated by measuring real token growth from
  a dry run before fixing the number.
- Subagents could duplicate work if given vague scope → mitigated by requiring
  explicit, narrow objectives + output contracts at dispatch time.

## 8. Verification plan

- Demo video: one full goal run, coding use case, crossing the compaction
  threshold at least twice, with a fact established early in the run still
  correctly influencing behavior after both compactions.
- This document, refined, becomes the required Approach document — including
  the gap-filling section above.
- Use-case list ships separately: the 3 use cases named here, with the one that
  was fully demoed called out explicitly.
