# Approach

## The problem

The task isn't really "build an agent loop." An agent loop is a solved problem. The thing being
tested is this: when the context window fills up, can the agent keep going without losing
anything that matters — and can you prove it after the fact?

So the design centers on one boundary: the moment the window fills and the agent has to
compact, checkpoint, and continue. Everything else exists to make that moment survivable.

## The core idea

The context window is a cache. Disk is the source of truth.

The agent never relies on the context window to remember anything important. Goal state lives
in `goal.md`. Working memory lives in `context.md`. Every tool call, every result, every
compaction goes to an append-only `checkpoint.jsonl`. When the window fills, the agent merges
its recent work into `context.md`, archives the raw pre-compaction buffer to the scratchpad,
and continues. Nothing is deleted. Things are only removed from *active* context.

This means a run can be replayed and audited from disk alone. The window is expendable; the
disk isn't.

## Decisions and trade-offs

**No framework. Hand-rolled state machine on the raw Anthropic SDK.**
The rubric scores "clean, extensible boundaries" and "navigable by someone unfamiliar." A
framework hides the exact thing being graded behind someone else's abstraction. Building from
primitives is more code, but the boundaries are visible — you can see the state machine, the
context manager, the orchestrator. That's the point.
Trade-off: more code to maintain, no community fixes. Worth it for a design-proving task.

**Compaction merges, doesn't append.**
Every compaction produces a new `context.md` that's roughly the same size as the last one —
goal restated, constraints and decisions, unresolved errors, completed steps, next planned
step. If it appended, the context would grow until it filled the window with summaries of
summaries.
Trade-off: the merge is an LLM call that could misjudge relevance. Mitigated by archiving the
exact pre-compaction buffer to the scratchpad first — nothing is actually lost, only
summarized. The original is one pointer away.

**Completion is checked against explicit success criteria, captured at intake.**
The spec doesn't define "goal complete." We force a definition: intake produces `goal.md` with
checkable success criteria, and a separate `validating_completion` phase checks the work
against them. The agent doesn't decide it's done by feel; it checks a list.
Trade-off: the criteria are LLM-generated, so they could be wrong. But a wrong explicit
criterion is better than no criterion — at least it's inspectable and correctable.

**The loop is bounded by progress, not time.**
Two stall detectors: tactical (same tool call repeated identically) and strategic (several
iterations with no mutating tool call succeeding). Read-only calls don't count as progress —
an agent reading files forever isn't working, it's stalling.
Trade-off: a genuinely stuck agent runs longer than a time-bounded one. But a time bound kills
work mid-thought, which is worse. Progress is the right signal.

**`/goal` in the REPL, not a CLI argument.**
Users don't launch with `rocket-agent "<goal>"`. They open the REPL and type. So the
autonomous loop (the thing the task is about) has to be reachable from inside the session.
`/goal <task>` drops into the infinite loop, reusing the live session — same run dir, same
checkpoint log. A bare prompt stays a chat turn. Explicit, like codex.
Trade-off: the user has to know the command. We print it in the banner. Auto-detecting "this
is a goal, not chat" would misfire on "Hello."

**CLI default (25K) stays high; the demo budget (12K) is a separate, explicit choice — not the
same knob used two different ways.**
The CLI's own default (`--compaction-budget`, 25,000) is sized for real unsupervised use: a
200K-token model doing production work should compact near the model's real ceiling, not
constantly. But 25K never fired even once across a full 33-tool-call calibration run of a
task this size — too high a bar to *demonstrate* the mechanism inside a reasonable run. 12,000
was chosen after measuring real token growth on this exact task shape (not guessed), and it's
still substantial — a real multi-file TypeScript project with its own test suite and tooling
setup, not a trivial task padded to look busy. The demo passes `--compaction-budget 12000`
explicitly, on the command line, visibly — the default is untouched for anyone who doesn't pass
that flag.
Trade-off: this means the demo doesn't exercise the literal default value. Accepted, because the
alternative — either hiding a lowered budget, or leaving 25K and hoping a big-enough goal happens
to cross it inside a sane iteration count — is worse: the first is dishonest, the second makes
the demo's outcome depend on guessing goal size correctly rather than on a stated, reproducible
parameter.

**Audit everything to `runs/<id>/`.**
Every run writes a manifest (`run.json`), a checkpoint log, per-compaction context snapshots
(`compactions/0001.md`, `0002.md`), a usage record per generate call, and a `run_end` record.
The run is self-evidencing — a reviewer can open the dir and verify every claim.
Trade-off: more I/O per run. Negligible next to the cost of the API calls themselves.

**`run_command` gets a real (if narrow) confinement check, not just a description asking nicely.**
Live testing surfaced two concrete gaps: a run with no local TypeScript compiler reached outside
its own workspace and invoked the *host* project's own `node_modules/.bin/tsc` by absolute path
(the tool's description said not to; nothing enforced it); a separate run's genuinely-passing
test command got reported as a failure because a diagnostic `grep` chained after it (via `;`)
returned its own unrelated exit code, which shell semantics report instead of the substantive
command's. Fixed both: `tools/policy.ts` now rejects a `cd` target or an invoked command that's
an absolute/`~` path resolving outside the workspace (narrow — only those two positions are
checked, so `curl -o /dev/null` and similar idioms aren't false-flagged); `run_command` now runs
under `set -o pipefail`, so a failure earlier in a `|` pipeline is reported instead of masked by
`tail`/`grep`. Also added a system-prompt line requiring pinned versions on any `npm install` of
dev tooling, after an unpinned install silently picked up a breaking TypeScript 7 preview release.
Trade-off: still a tripwire, not a real sandbox (see the note on `denyKnownDestructiveCommands`'s
own successor, `makeToolCallPolicy` — string-level checks can't stop a sufficiently adversarial
command). Raises the bar against the realistic failure mode actually observed, not against attack.

**One model provider, behind an interface.**
`ModelClient.generate()` is the interface; `AnthropicClient` is the one implementation. The
loop, orchestrator, and context manager depend on the interface, not the SDK. Swapping
providers is one new file.
Trade-off: only one implementation exists. Building a second one now would be scope creep —
nothing requires it, and the abstraction is what proves the design, not a second concrete class.

## What the spec left undefined

The spec says "runs until its goal is complete" and "no goal-relevant information may be
permanently lost." It doesn't say how to know the goal is complete, what happens when the
agent gets stuck, or how you prove continuity after the fact. These aren't edge cases —
they're the substance.

- **What "goal complete" means.** Undefined. Filled with explicit success criteria at intake,
  checked by a separate validation phase.
- **Human clarification.** Silent. Filled with a one-shot, non-blocking intake — an unattended
  agent can't wait indefinitely on a human who may not be there.
- **Non-termination.** Silent. Filled with progress-based stall detection (tactical and
  strategic), never time-based.
- **Tool or subagent failure mid-run.** Silent. Filled with a failure taxonomy, retry-once at
  the subagent layer, and checkpoint-before-surface so a crash never loses unlogged work.
- **Cost runaway.** Not mentioned. Filled with a hard iteration cap.
- **Auditability.** Not mentioned. Filled with a run manifest, per-compaction snapshots, a
  usage record per generate call, and a `run_end` record that closes the log. Two smaller
  gaps — assistant reasoning text between tool calls isn't checkpointed (only streamed), and
  intake's raw response is discarded once parsed into `goal.md` — are deliberately left, not
  fixed: both are substantially mitigated (compacted turns' text lives in the scratchpad
  archive; `goal.md` is intake's authoritative output) and closing them fully would touch
  validated hot paths for narrow gain.

## Proof

The demo run is a CLI task tracker (TypeScript, Node built-ins only): `add`/`list`/`done`/`remove`
subcommands, JSON persistence with atomic writes (temp file + rename), monotonically-increasing
never-reused ids, and a `node:test` suite.

Run `run-1785563855661-04090afe`, launched via `/goal` at `--compaction-budget 12000
--max-iterations 45 --effort medium`:
- **2 compactions** (checkpoint seq 28, merging 18 turns; seq 62, merging 16 turns).
- 31 tool calls across 28 iterations: 17 `run_command`, 6 `write_file`, 3 `edit_file`,
  2 `read_file`, 2 `read_scratchpad`, 1 `list_dir`.
- The agent wrote `src/store.ts`, `src/cli.ts`, `test/cli.test.ts`, `package.json`,
  `tsconfig.json`, `README.md`, and installed `typescript`/`@types/node` at exact pinned
  versions (no `^`/`~`) inside the workspace, per the goal's own requirement.
- **18/18 tests pass** (`ℹ pass 18`, `ℹ fail 0`) — reconfirmed by re-running the suite directly
  in the run's workspace after the fact, not just trusting the transcript.
- The run reached **"Goal complete"** (`run.json`: `"finalStatus": "done"`) — it did not hit the
  iteration cap.
- Both compactions archived the raw pre-compaction buffer to the scratchpad before merging;
  `context.md` carried state forward across both boundaries.

The continuity proof: the atomic-write decision (temp file + `fsync` + `rename`) and the
never-reuse-id requirement, both established at intake, appear verbatim in `context.md` after
both compactions — and the agent's own recorded smoke test in that same post-compaction context
confirms the behavior actually held: removing id 2 and adding again produced id 3, not a reused
2. The information survived both boundaries and still governed behavior at the end.

An earlier attempt at this same use case (`run-1785498185100-3abb08be`, a larger markdown notes
manager, 2 compactions, 51/51 tests) hit the then-default 60-iteration cap before reaching the
completion check — a calibration gap, not an architecture failure. That's exactly why the
default is now 120 (see "What's still missing" below).

## What's still missing

- **~~The recorded run didn't finish.~~ Fixed.** The default iteration cap was 60, miscalibrated
  for a real-sized task; raised to 120. The current recorded run (`run-1785563855661-04090afe`)
  reaches `"finalStatus": "done"` with 2 compactions inside 28 iterations.
- **No second model provider.** The interface exists; only Anthropic is implemented.
- **Concurrency and timeout numbers are placeholders.** The mechanisms (heartbeat ledger,
  retry-once, per-tool timeout override) are built; the exact values aren't tuned.
- **Assistant reasoning text isn't checkpointed.** Only tool calls and results are logged. The
  model's prose between actions streams to the terminal and is discarded — except for
  compacted turns, whose text is preserved in the scratchpad buffer archive.
- **No cross-run memory.** Each run is independent. Long-term memory spanning goals is out of
  scope.
