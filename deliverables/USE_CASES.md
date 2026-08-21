# Use cases

Each entry is a *class* of problem this agent is built to handle, not one fixed task. For each:
what the scope is and why the architecture covers it, then what we actually ran as evidence, or
why we judged it already covered without a dedicated run.

## 1. Multi-file software engineering — build, test, iterate to green

**Scope:** any task where "done" has an objective, checkable signal — a test suite, a type
checker, a build that succeeds or doesn't. Covers CLIs, small services/APIs, libraries,
scripts — anything where the agent writes code, runs it, sees it fail, and fixes it, across as
many files and iterations as the goal needs. This is the general-purpose case the architecture
is built around: intake's explicit success criteria and the `validating_completion` check both
assume "done" is checkable, not a feeling.

**Attempted:** a CLI task tracker in TypeScript (`add`/`list`/`done`/`remove`, atomic JSON
persistence, monotonically-increasing never-reused ids, structured error handling, a `node:test`
suite, pinned tooling). `run-1785563855661-04090afe` — 2 compactions, 31 tool calls, 18/18 tests
passing (reconfirmed after the fact), reached `"finalStatus": "done"`. A fact established at
intake (the atomic-write decision) survived both compaction boundaries verbatim and still
governed behavior at the end.

**Also attempted, same scope, larger instance:** a markdown notes manager (REST API + file
storage + CLI + validation + tests, 15+ files). `run-1785498185100-3abb08be` — also 2
compactions with state carried correctly across both, 51/51 tests, but didn't reach completion
under the then-default 60-iteration cap (a calibration gap, since fixed — default raised to 120).

## 2. Parallel task decomposition — independent subtasks via `dispatch_subagents`

**Scope:** goals that decompose into independent (or dependency-ordered) pieces — N independent
CRUD endpoints, N files needing the same class of change — are better delegated in parallel than
serialized. `dispatch_subagents` exists for exactly this: narrow explicit sub-objectives,
optional `dependsOn` ordering, bounded concurrency, capped summary report-back per subtask.

**Attempted:** a bookmarks API, 4 CRUD endpoints delegated to 4 parallel subagents.
`run-1785422910960-cba39123` (5 compactions) and `run-1785478544657-85d4caab` (4 compactions) —
subagent delegation worked, all 4 endpoints built correctly. This is also where
`--compaction-budget 12000` came from: measuring real token growth on real work rather than
guessing. Not used as the headline proof for use case 1 because it's thinner — fewer decisions
worth tracking across a boundary — but it's the real evidence for this scope.

## 3. Boundary-mechanism integration testing

**Scope:** not a real user goal — a way to exercise the compaction path (archive → merge →
checkpoint → resume) directly, isolated from any task's own complexity, so a failure here can
only mean the machinery itself is broken.

**Attempted:** a trivial "write 'hi' to hello.txt" goal at `--compaction-budget 1`, forcing
compaction after the first tool call. Several runs, 2–5 compactions each on a one-file task —
proves the archive/merge/checkpoint/resume flow end to end, independent of task complexity.

## 4. Research/synthesis — multi-source input to a structured report

**Scope:** swap `run_command`/`edit_file` for `web_search`/`web_fetch`; the state machine,
context manager, and orchestrator don't change. The same continuity guarantee applies to "don't
lose a source or a citation across a compaction" instead of "don't lose a code decision."

**Not run:** architecturally covered, not empirically — the tool registry is the seam, and the
loop doesn't know or care what the tools do. A second, shallower run would prove less than
running one use case deeply already does.

## 5. Large refactor/migration — many existing files, one continuity story

**Scope:** arguably the harder version of use case 1 — touches many *existing* files rather than
a blank slate, so the agent has to track not just its own prior decisions but the constraints of
code it didn't write, across every compaction boundary.

**Not run:** same reasoning as #4 — one deep, evidenced use case beats several shallow ones for
proving the mechanism actually works.
