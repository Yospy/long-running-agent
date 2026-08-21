# Todo — Infinite-Running Agent

Tracks execution against `sprints/agent-architecture-approach.md` (finalized design).
Backend first, terminal UI last — see file layout in the sprint doc, section 9.

## Phase 0 — Scaffolding
- [x] package.json (ESM, Node LTS target), tsconfig.json (strict)
- [x] Install deps: @anthropic-ai/sdk (0.115.0 — 0.32.1 was stale), commander, dotenv, zod, better-sqlite3, vitest, tsx
- [x] src/ directory skeleton per file layout
- [x] .env.example (mirrors .env keys, no values)

## Phase 1 — Core backend (bottom-up, by dependency) — DONE, reviewed
- [x] `model/client.ts` — ModelClient interface + AnthropicClient impl, stable-prefix + cache_control, adaptive thinking + effort, refusal/typed-error handling, opaque-block passthrough, explicit 5min request timeout
- [x] `errors/taxonomy.ts` — structured error types (trimmed to the 5 kinds actually thrown; removed 3 unused ones the review caught)
- [x] `context/checkpointLog.ts` — append-only JSONL read/write, job-id tagged, seq resumes across restarts
- [x] `context/scratchpad.ts` — size-based routing (~500 token threshold), namespaced per job
- [x] `context/contextWindow.ts` — assembles prefix + goal.md + context.md + raw buffer
- [x] `context/compactor.ts` — token-budget trigger (real usage tokens, not estimated), merge-template compaction (not append)
- [x] `tools/registry.ts` — zod schema validation + dispatch, generic 90s safety-net timeout
- [x] `tools/fileTools.ts` — read/write/edit/list/search, path-traversal hardened
- [x] `tools/runCommand.ts` — shell exec under hard timeout (SIGTERM → grace → SIGKILL)
- [x] `tools/scratchpadTools.ts` — read_scratchpad (explicit fetch-back)
- [x] `tools/humanInput.ts` — request_human_input (rare escape hatch, advisory only)
- [x] `loop/state.ts` — phase union + transition legality table
- [x] `loop/intake.ts` — one-shot, non-blocking clarification phase → seeds goal.md (now idempotent, skips re-intake if goal.md exists)
- [x] `validation/completion.ts` — validating_completion vs explicit success criteria
- [x] `loop/run.ts` — main driver loop, wires all of the above; compact/checkCompletion/runIntake all now error-safe (review caught these as uncaught-crash paths)
- [x] `orchestrator/ledger.ts` — Map<jobId, {status, lastHeartbeatAt}>
- [x] `orchestrator/subagent.ts` — spawn/dispatch, reuses loop/run.ts, capped summary report-back, retry-once-then-surface
- [x] Stall detection — tactical: repeated identical tool call; strategic: fixed to require a *mutating* tool success (read-only cycling no longer resets the counter — review-caught bug)
- [x] Unit tests per module (vitest) — 16 tests, incl. two loop/run.ts integration tests added specifically to regression-test the review findings

**Neutral subagent review completed.** Findings and resolutions:
- Fixed: uncaught errors from `compact()`/`checkCompletion()`/`runIntake()` could crash the loop — now all wrapped and degrade gracefully.
- Fixed: strategic-stall counter treated any successful tool call as "progress," so a model cycling through read-only calls could stall silently for the full iteration budget — now requires a mutating tool call.
- Fixed: no explicit request timeout on the Anthropic SDK client — added (5 min).
- Fixed: dead code — `makeIdempotencyKey` and 3 unused `ErrorKind` values removed (no retry-of-a-single-call mechanism exists yet to make idempotency keys meaningful).
- Fixed (partial): intake is now idempotent (won't overwrite an existing goal.md), mitigating the sharpest edge of the resume gap.
- **Deliberately deferred, not fixed** (documented for the approach doc, not silently skipped):
  - No `cli.ts` yet, so nothing has been run end-to-end — expected at this point; that's Phase 2.
  - No true crash/process-restart resume from the checkpoint log (only in-process compaction continuity, which is what the spec's context-window-boundary requirement is actually about). Building full replay would need a new checkpoint event type capturing raw assistant turns plus buffer/phase reconstruction — a real feature, not a quick fix.
  - Heartbeat staleness is observability-only; enforcement comes from layered timeouts (tool-level, registry-level, SDK-level) + the iteration cap, not active staleness polling.
  - Subagent retry restarts the subtask from scratch, not from its own checkpoint (follows from the resume gap above).
  - File-path resolution is lexical, not realpath-based — a model-planted symlink could theoretically escape the project root. Low severity: the tool surface gives the model no way to create symlinks except via `run_command`, and the demo task has no incentive to.

## Phase 2 — Terminal UI + wiring — DONE, reviewed, live-verified
- [x] `loop/systemPrompt.ts` — static harness system prompt (autonomy, when to stop, when to delegate, verify-before-claiming-done, code-quality bar)
- [x] Streaming — `StreamEvent` + `onStreamEvent` on `GenerateParams`; `AnthropicClient` uses `sdk.messages.stream()` internally, verified against installed SDK source (not guessed), still returns the same `GenerateResult`
- [x] Full-fidelity compaction — raw buffer archived to scratchpad before discard, pointer on the compaction checkpoint entry
- [x] `dispatch_subagents` `dependsOn` — topological batches, dependency-result folding, cycle detection, skip-on-failed-dependency, duplicate-jobId rejection
- [x] `cli.ts` — commander CLI, dotenv, workspace/runDir split, two tool registries (orchestrator-only `dispatch_subagents`), streaming terminal render via `node:util` `styleText` (no new dep)
- [x] `generateWithRetry` (`model/client.ts`, provider-agnostic) — all 4 LLM call sites now retry on recoverable failures instead of calling `client.generate()` directly
- [x] `toAgentError` fixed twice: in-band SSE errors classified by `error.type` not just `status`; `APIUserAbortError` (our own timeout, mid-stream) added as recoverable
- [x] `tools/policy.ts` — harness-level `ToolCallPolicy` gate in `ToolRegistry.dispatch()`, applies to every tool; `denyKnownDestructiveCommands` inspects `run_command` for recursive-delete-outside-workspace, mkfs/dd, fork bombs, remote-script-to-shell pipes, `sudo` — explicit tripwire, not real security, per the §4.11 known-limitation
- [x] 36 vitest cases total (was 22) — `dependsOn` (parallel/fold/diamond/cycle/dup-id/skip), archival, `generateWithRetry` retry/no-retry/exhaustion, completion-checker buffer visibility, policy gate (allow/deny logic + wired through a real registry)
- [x] Three live runs against the real API: completion-check fix confirmed (clean 6-entry run), compaction-boundary + archival confirmed (triggered correctly, no in-flight work lost), retry mechanism confirmed absorbing a real sustained `overloaded_error` before failing cleanly, policy gate confirmed not interfering with normal tool use

**Severe bug caught only by running it for real:** `checkCompletion` never saw the raw buffer,
only `context.md` — which is empty until the first compaction. Every short run (and the first
stretch of every long run) was being judged against zero evidence and could never pass. Live smoke
test hung in exactly this loop before the fix. See sprint doc §4.11 for full detail on this and
the other review findings/fixes.

**Known, deliberate, partially mitigated (not closed):** `run_command` only sets `cwd`, not a real
sandbox — a command using `..`/absolute paths/symlinks can still reach files outside the workspace,
including the run's own audit trail. Tool description says so explicitly. Added a harness-level
policy gate (§4.12) that blocks the unambiguously destructive cases (recursive delete escaping the
workspace, disk-format/raw-write commands, fork bombs, remote-script-to-shell pipes, `sudo`) — a
tripwire against accidental self-inflicted damage, explicitly not real security; a determined
adversarial command can still route around string matching. Real sandboxing (containers/namespaces)
stays out of scope as previously decided.

## Phase 3 — Demo task + verification
- [x] Remove unused `better-sqlite3`/`@types/better-sqlite3` from Rocket's own `package.json` —
      dead weight from Phase 0 scaffolding (zero usage in `src/`/`tests/`, confirmed by grep). The
      demo task's SQLite dependency belongs to the *agent's own workspace*, installed by the agent
      itself via `run_command` as part of building the bookmark manager from scratch — not
      pre-installed in the harness. `npm install` re-run after removal; typecheck + all 36 tests
      still pass.
- [ ] Lock the demo goal text (final, below) — must explicitly direct subagent delegation across
      the 4 CRUD endpoints, since leaving it implicit risks the model not choosing to delegate on
      the recorded take:

      > Build a bookmark manager REST API from scratch in the workspace: Node.js, Express,
      > better-sqlite3 for persistence. Set up the npm project yourself (package.json,
      > dependencies, a SQLite schema). Implement four independent endpoints — create, list,
      > delete, search — as four separate handlers against the same schema. Delegate the four
      > endpoints to four parallel subagents, one per endpoint, since they're independent CRUD
      > operations. After they report back, wire their endpoints into one Express app, write a
      > shared test setup, run the full suite, and fix any integration issues yourself. Done only
      > when `npm test` passes with coverage for all four endpoints.
- [x] Dry run #1 (real API, `run-1785406527101-f373caf5`, capped at 25 top-level / 12 per-subagent
      iterations to bound cost): the actual work finished cleanly — 4 subagents delegated in
      parallel, handlers + tests written, `npm test` 38/38 passing, server smoke-tested via curl,
      README written — but hit the iteration cap 1-2 steps before reaching the `done` phase, and
      **zero compactions fired anywhere** (main or any of the 8 subagent dispatches) across the
      whole run. Finding: the 25K default is too high a bar for this task size within a reasonable
      iteration budget — needs to be lowered for the recorded demo so the boundary is actually
      crossed ≥2 times, not left to chance.
      Three real bugs surfaced by this run (code review alone would not have caught these), all
      fixed and regression-tested:
      - `tools/policy.ts` false positive — `denyKnownDestructiveCommands` matched the recursive-rm
        pattern and the workspace-escape pattern independently anywhere in a whole compound shell
        command, so an innocuous `rm -rf coverage` got denied because an *unrelated* `curl -o
        /dev/null` later in the same line matched the escape pattern. Fixed by scoping both checks
        to the same shell sub-statement (naive split on `;`/`&&`/`||`/`&`/`|`/newline — still not a
        real parser, still documented as a tripwire not real security). Regression tests added to
        `tests/policy.test.ts`.
      - `loop/intake.ts` truncation mis-reported as "malformed JSON" — 6 of 8 subagent intake calls
        failed on the first attempt this way. Root cause: `maxTokens: 2048` with no `stopReason`
        check, so a structured-output response listing several assumptions/success criteria could
        get cut off mid-JSON. Fixed: bumped to 4096, added an explicit `stopReason === "max_tokens"`
        check with an accurate error message, and marked both intake failure paths `recoverable:
        true` (matches what was actually observed — the existing subagent-level retry-once always
        succeeded). New `tests/intake.test.ts`.
      - `npm test` had no vitest config, so it globbed the whole project by default — including
        `runs/<runId>/workspace/tests/*.test.js`, the demo app's own Jest-style tests the agent had
        just written. Latent since Phase 0; never surfaced before because no run had produced test
        files until this one. Fixed with `vitest.config.ts` excluding `runs/**`.
      - All 41 tests pass (was 36 + this run's regressions), typecheck clean.
- [x] Dry run #2 (`run-1785407219196-d2c65067`, `--compaction-budget 12000 --max-iterations 45
      --subagent-max-iterations 15`) — **full success on the primary goal**: reached `done`
      cleanly (exit 0), main job compacted exactly twice (seq 113: 22 turns merged; seq 142: 8
      turns merged, both archived to scratchpad with pointers), zero policy denials, zero
      intake malformed/truncated errors — confirms all three dry-run-#1 fixes held. 12K is the
      right compaction budget for the recorded take.
      One new bug found and fixed: `dispatch_subagents` hit the registry's generic 90s
      safety-net timeout (`"Tool dispatch_subagents exceeded 90000ms"`, seq 89) even though all
      four dispatched subagents were still correctly completing their work — `ToolRegistry`'s
      `withTimeout` races a timer against the promise but never cancels it, so the main loop
      moved on believing the dispatch had failed while the subagents kept writing files
      underneath it, silently discarding the structured fulfilled/rejected/skipped outcome
      contract. The orchestrator recovered by re-reading files off disk as an improvised
      fallback — it worked this time by luck of timing, not by design. Fixed properly: added an
      optional per-tool `timeoutMs` override to `Tool<TInput>` (`tools/registry.ts`), and set
      `dispatch_subagents` to 30 minutes (`orchestrator/subagent.ts`) — a last-resort safety net
      against a genuinely hung promise, not an operational ceiling; actual duration is already
      bounded by `maxIterationsPerSubagent` and each generate call's own retry/timeout budget.
      Regression test added to `tests/registry.test.ts`. 42/42 tests pass, typecheck clean.
      (Separately, `run_command` itself also hit its own 90s ceiling once, mid-smoke-test,
      because a backgrounded `node` process kept the shell open — this is the *intended*
      SIGTERM→SIGKILL safety mechanism working correctly, and the agent adapted its own command
      on retry. Not a bug; good evidence for the error-handling write-up.)
- [x] Dry run #3 (`run-1785407869207-c5830e03`, same params as #2) — **`dispatch_subagents` fix
      confirmed** (zero timeout entries anywhere in the checkpoint log), main job compacted
      **3 times** (seq 111/138/159: 24/26/14 turns merged), zero policy denials, reached `done`
      cleanly, 16/16 tests passing in the built app, a genuinely useful self-written integration
      report (harmonized a limit-validation convention mismatch between two independently-built
      handlers, caught a route-shadowing risk, added JSON-parse error middleware).
      Bonus finding, not a blocker: `endpoint-delete` failed internally mid-run — its own
      completion check hit the *same* truncation defect as intake (`"Completion check returned
      malformed JSON"` / `"produced no structured output"`, `validation/completion.ts`, same
      `maxTokens` + missing `stopReason` check pattern as the already-fixed `intake.ts`) and burned
      its whole 15-iteration budget. The existing subagent-level retry-once mechanism caught it
      automatically — `endpoint-delete-retry` succeeded cleanly with zero human intervention. Good
      evidence for the error-handling write-up (a real internal failure, recovered without help),
      but the root cause still needed fixing:
      - `validation/completion.ts`: same truncation-mis-reported-as-malformed-JSON defect as
        `intake.ts`, `maxTokens: 1024` → 2048 + explicit `stopReason === "max_tokens"` check.
      - `context/compactor.ts`: audited every other structured/constrained-output call site while
        fixing the above and found the **same missing check in a more dangerous place** — `compact()`
        has no JSON.parse step, so a truncated response would be *silently accepted* as the new
        context.md with no error at all. Since `## Next planned step` renders last in the compaction
        template, truncation would silently drop exactly the section most needed to resume — the
        precise failure mode this whole project exists to prevent. Fixed the same way (`maxTokens`
        4096 → 8192, explicit `stopReason` check that throws instead of returning partial text).
      - Both fixes are unit-tested (`tests/completion.test.ts`, `tests/compactor.test.ts`) but not
        re-verified live — treated as sufficient given the failure mode was already observed and
        safely absorbed once by the retry mechanism, and the fix pattern was already proven live in
        `intake.ts`. 44/44 tests pass, typecheck clean.
      **Parameters locked for the recorded take**: `--compaction-budget 12000 --max-iterations 45
      --subagent-max-iterations 15 --effort medium`, same goal text as dry runs #2/#3.
- [x] Terminal UX pass before the recorded take, per explicit request ("streaming, intermediate
      reasoning steps... friendly and intuitive"):
      - **Subagent reasoning was previously invisible** — only bare `[jobId] tool: X` lines; the
        main job's own reasoning was visible only because raw token streaming (`onStreamEvent`) is
        wired solely into the top-level call, deliberately not into subagents (interleaving 4
        concurrent raw token streams would look like garbage, not "friendly"). Fixed with a
        middle ground: `loop/run.ts` now emits a job's finished turn text via the existing
        `onEvent` line mechanism whenever `onStreamEvent` isn't wired for that job — coherent
        per-turn reasoning, not live tokens, but no longer silent. Guarded against double-display
        for the main job (which already shows it live). Verified live: subagent reasoning ("Done.
        `hello.txt` exists... verified via hexdump...") now renders cleanly in the terminal.
        Regression tests in `tests/run.test.ts` (surfaces when unstreamed, suppressed when
        streamed).
      - **Deeper bug found while live-verifying the above**: the same smoke-test task re-triggered
        the "truncated at token limit" completion-check error *even at the already-bumped 2048
        cap* — on a task trivial enough that message length wasn't the real explanation. Root
        cause: `thinking: {type: "adaptive", display: "summarized"}` was applied unconditionally
        to *every* call in `model/client.ts`, including intake/completion/compaction — adaptive
        thinking has no fixed budget, its output counts against the same `maxTokens` ceiling as
        the final answer, so a bout of thinking can starve trivially small structured output
        regardless of how generous `maxTokens` is. Bumping the numbers only made this less likely,
        not impossible. Fixed at the root: added `thinking?: boolean` to `GenerateParams`
        (default true, preserves the main planning loop's reasoning), set `thinking: false` on the
        intake/completion/compaction call sites — these are narrow, bounded judgment calls that
        don't need extended reasoning in the first place, so removing it is the correct design,
        not just a workaround. Re-ran the exact task that failed: clean, zero errors, zero retries.
      - 46/46 tests pass, typecheck clean.
- [x] Neutral subagent code review of the UX changes above (explicitly requested) — read all
      touched files itself, ran `typecheck`/`test` independently, gave 4 genuine findings (no
      rubber-stamping). All fixed:
      1. **(Medium, real)** `compact()` failure aborts the *whole job*, unlike intake/completion
         which just loop back — so a residual truncation (thinking-disabled reduces but doesn't
         eliminate the risk for a large enough transcript) was fatal on the one path that protects
         context continuity. Fixed: one retry at double the token budget before giving up.
      2. **(Medium, real)** zero test coverage for the actual `thinking` gate — nothing asserted
         the key was really included/excluded from the request, or that the three call sites
         really passed `thinking: false`. Fixed: extracted request construction into a pure,
         exported `buildRequest()` in `model/client.ts` (new `tests/client.test.ts`, 6 cases), plus
         explicit `thinking: false` assertions added to `intake.test.ts`/`completion.test.ts`, and
         a scripted-retry test in `compactor.test.ts` covering the fix above.
      3. **(Low-medium, real)** emitted turn text was uncapped and only the first line carried the
         `[jobId]` prefix — a multi-paragraph block's continuation lines were unattributed, a
         milder version of the interleaving problem this whole mechanism was meant to avoid. Fixed:
         capped at 2000 chars, every line individually prefixed.
      4. **(Nitpick)** a doc comment called the surfaced text "reasoning" — corrected to say it's
         the model's answer/commentary text specifically, not its thinking trace (which stays
         opaque by design).
      56/56 tests pass (was 46), typecheck clean. Re-ran the live smoke test after all four fixes:
      clean, zero errors, multi-line subagent output now shows correctly per-line-attributed.
- [ ] Full recorded run crossing the boundary ≥2 times, checkpoint log inspected for continuity
- [ ] Record demo video
- [ ] Finalize approach doc (sprint doc → approach doc) + use-case list

## Interactive REPL UI (additive, see sprints/interactive-repl-ui.md)
- [x] `loop/session.ts` — turn-based `runInteractiveSession`, no completion-check phase (human
      decides when satisfied instead), reuses compaction/tool-dispatch/stall-detection from the
      existing modules. Does not modify `loop/run.ts`'s behavior.
- [x] `cli.ts` — `[goal]` argument now optional; omitted launches the interactive session.
      Monochrome rendering: bordered input box (`node:readline/promises`), live context-window
      gauge, bordered compaction block showing the actual merged context.md, rich tool-call
      labels (`Write(path)`, `Bash(cmd)` style), live token streaming during each turn.
- [x] 66/66 tests pass (was 56) — `tests/session.test.ts` (10), `tests/client.test.ts` (6, added
      alongside extracting `buildRequest()` for testability). Typecheck clean.
- [x] Live-tested via a pty-based harness (real terminal emulation, not a plain pipe — piped/
      non-TTY stdin hides real echo/buffering behavior that only shows up in an actual terminal).
      4 real bugs found and fixed this way — see sprints/interactive-repl-ui.md's implementation
      notes for detail: a broken `onCompaction` callback signature, missing live streaming during
      turns, structural output getting stuck onto unterminated streamed text, and a duplicate-
      display bug mirroring one already fixed in the autonomous mode. Also stress-tested with a
      deliberately extreme 500-token compaction budget (5 compactions in one turn) — confirmed
      tactical stall detection and compaction both persist correctly across compaction boundaries
      within a single turn.
- [x] Neutral subagent code review — independently live-tested the running CLI itself (not just
      the code) and found 3 real bugs: Ctrl+C hung indefinitely (`rl.close()` doesn't settle a
      pending `question()` — needed an `AbortController`), `boxTextLine()` measured already-styled
      text so the banner/compaction-block borders misaligned in a real terminal (styleText is a
      no-op outside a TTY, so this only showed up live), and `runInteractive()` had no top-level
      catch unlike the autonomous mode. All fixed and re-verified live (Ctrl+C: clean exit in
      ~1s; borders: confirmed aligned in a real pty with real ANSI codes active). Also extracted
      the pure rendering functions into `src/cli/render.ts` (untestable inside `cli.ts` itself,
      which runs `program.parseAsync()` on import) and added the 3 test cases the review flagged
      as live-tested-but-not-unit-tested. 82/82 tests pass (was 66), typecheck clean.

## Interactive UI redesign — ephemeral status, timing, boxless (see sprints/interactive-repl-ui.md §8)
- [x] `src/cli/ephemeralRegion.ts` — `EphemeralRegion`, redraw-in-place via `node:readline`
      cursor control, TTY-aware fallback to plain lines when piped. 8 tests.
- [x] One unified status region (not two, per a design flaw caught on paper before implementing)
      showing an elapsed-time ticker, the current tool call, and one line per active subagent —
      replaces the old growing per-tool-call list.
- [x] `session.ts`: new `onGenerateStart`/`onTurnEnd` hooks (additive).
- [x] `render.ts` redesigned: box-drawing removed entirely, added `formatElapsed`/
      `formatTurnSummary`/`renderCompactionSummary` (boxless). 12 tests.
- [x] Real bug caught live (not by unit tests): subagent activity was routed through the wrong
      `onEvent` (bound at dispatch-tool construction, not `runInteractiveSession`'s own param) —
      the new ephemeral routing was fully inert on first live run. Fixed by parameterizing
      `buildToolRegistries`'s dispatch `onEvent` per mode.
- [x] Color pass: all `styleText("dim", ...)` removed project-wide — plain/bold/red only.
- [x] Live-verified 3x via pty: subagent lines update in place and correctly fall through to
      permanent scrollback for substantive commentary (not truncated); 3 real compactions in one
      session render correctly boxless; final turn summary matched the real transcript exactly
      (`write_file×1, run_command×3 · 3,506 tokens`).
- [x] 89/89 tests pass (was 82), typecheck clean.
- [x] Neutral subagent review — built its own virtual-terminal emulator to replay the actual ANSI
      codes rather than trust comments. Found 4 real issues, all fixed and re-verified live:
      1. **(High)** the status region never checked `interactiveAtLineStart` before drawing —
         confirmed live (visible in my own earlier logs, missed at the time): unterminated
         streamed text followed by a tool call announcement squished onto one line
         (`"...for you.⏺ read_file(config.json)"`). Fixed: inject a defensive newline only when
         the region is starting a *fresh* draw (not already active) and not at line start —
         doesn't disturb the in-place overwrite once the region is active.
      2. **(Medium)** a subagent's final-report branch called `clearAllStatus()`, wiping *every*
         concurrently-running subagent's tracked status, not just hiding the reporting one's line
         on screen — the others would stay missing until their own next event. Fixed: delete only
         the reporting job's entry, then redraw whatever remains.
      3. **(Medium)** the status/commentary routing heuristic (a prefix match) had a narrow
         residual risk: a subagent's own free-form report text could coincidentally open with a
         whitelisted word and get silently swallowed into the capped ephemeral line. Tightened the
         patterns to the exact shapes the harness actually emits (verified against every relevant
         `emit()` call site); fully closing it would mean loop/run.ts marking status lines
         explicitly, which touches already-validated code for a narrow edge case — documented as
         an accepted, narrowed-not-eliminated limitation rather than done here.
      4. **(Low, documented not fixed)** a few `checkpointLog.append()` calls inside the turn loop
         are unguarded; a genuine I/O failure there would skip `onTurnEnd` and end the session via
         the outer catch instead of returning to the prompt. Rare, and the fallback is still a
         clean, friendly error — not silent — so left as a documented limitation rather than
         wrapping every checkpoint call site.
      Also fixed a trivial duplication (`formatElapsedShort` re-implementing `formatElapsed`) and,
      caught during live re-verification of fix #1 (not by the reviewer), a related legibility
      issue: thinking and answer text could run together with no separator when the model
      transitions between them mid-stream — fixed with the same interactiveAtLineStart-aware
      pattern. 89/89 tests still pass, typecheck clean, both fixes confirmed live via pty.
- [x] User-reported gap: the very first message of every session sat blank (no ticker) until
      intake resolved — intake makes a real, non-streaming LLM call entirely outside the
      `onGenerateStart` instrumentation. Fixed with one line (fire `onGenerateStart` before intake
      too); the existing hand-off logic already covers cleanup correctly (the turn loop's own
      first generate() call re-fires `onGenerateStart` right after, naturally resetting the
      ticker). New regression test (counts exact `onGenerateStart` calls: 1 for intake + 2 for the
      turn loop). 94/94 tests pass, typecheck clean, confirmed live — "Thinking… 0s" now appears
      immediately after submitting the first message.
- [x] User-reported: wanted the current tool call combined with live elapsed time and token count
      in one status line (reference: Claude Code's own "Running 2 shell commands… (1m 52s · 5.4k
      tokens)" pattern), not tool calls shown separately from time/tokens (which previously only
      appeared once, at the very end). Redesigned the ticker from per-generate-call to per-turn:
      one continuously-running tick composes `<activity> (elapsed · tokens)` fresh every second,
      where `<activity>` is whatever's currently happening (intake/thinking/a tool call) — time
      and tokens now advance live through tool execution too, not just while waiting on the
      model. Also closed the same "blank until it resolves" gap for compaction's own generate()
      call (same root cause as the earlier intake fix). Caught and fixed a genuine variable-
      shadowing bug of my own while wiring this (a stale local `turnStartedAt` alongside the new
      module-level one). Live-verified: main status line now reads exactly like
      `⏺ dispatch_subagents(...) (58s · 3,796 tokens)`, updating every second.
      Separately found live (not part of the ask, but directly adjacent): the concurrency/
      heartbeat feature added to `orchestrator/subagent.ts` introduced five new event message
      shapes (`subagent started/queued/still running/done/failed/skipped`) that the status-vs-
      commentary routing regex didn't recognize, so they were falling through to permanent
      scrollback — reintroducing the exact "growing list" problem this whole area exists to
      prevent. The regex already carries a matching `subagent (...)` alternative covering all
      five. 94/94 tests pass, typecheck clean.
- [x] Three follow-up requests, all implemented and live-verified together:
      1. **Orange for the status area.** No "orange" in styleText's named-color set (ANSI 16-color
         has no such name); used a raw 256-color escape (`\x1b[38;5;208m`), gated on `isTTY` the
         same way styleText itself no-ops off a real terminal. Applied via `EphemeralRegion`'s new
         optional `style` parameter on `update()` — applied *after* truncation, not before (the
         same padding-order lesson from the earlier box-drawing bug: a style wrapper's bytes must
         not count toward the width cap, or real content gets cut short).
      2. **Tool use shown separately** — a verb-phrase summary line plus an indented `└` detail
         line (the path/command/pattern), e.g. `⏺ Running shell command… (12s · 3.2k tokens)` /
         `  └ $ npm test`, instead of one crammed `run_command(npm test)` line. New
         `formatToolActivity()` in `render.ts` replaces `formatToolLabel`.
      3. **Rotating verbs instead of a static "Thinking…"** — Rocket's own word list (Reasoning,
         Planning, Analyzing, Synthesizing, Deliberating, Processing, Formulating, Strategizing,
         Computing, Considering), randomly picked each time a new generate() call starts —
         matching the *pattern* Claude Code uses (varied single-word status verbs), not its
         specific vocabulary, since this is a different product.
      Live-verified together: orange escape codes present in the raw output stream; verb rotation
      confirmed across a real multi-call turn (Synthesizing… → Planning… → Reasoning…); two-line
      tool display confirmed for both a plain tool call and `dispatch_subagents`. 97/97 tests pass
      (new: `EphemeralRegion`'s style-after-truncate ordering, `formatToolActivity`,
      `THINKING_VERBS`), typecheck clean.
- [x] User-reported (screenshot): four fixes together —
      1. **Turn summary was plain white, not orange.** Real bug: the `onTurnEnd` call site never
         passed the `orange` style argument to `printPermanentLines`. One-line fix.
      2. **Long shell commands wrapped with no hanging indent**, breaking the left-aligned "└ "
         look, once tool calls became permanent (no more automatic 100-char cap from
         `EphemeralRegion`, which only applied to the old ephemeral version). Added a dedicated
         90-char cap on tool-call *detail* lines specifically — the tool call itself is still
         always shown (nothing hidden/summarized), only a single very long argument gets
         shortened for display.
      3. **Input highlight, without risky cursor math.** Printing the prompt with an unclosed
         inverse-video escape code means the terminal's own line-editing echo of what the user
         types inherits the highlight automatically (SGR styling state persists until reset) —
         no need to erase and reprint the already-echoed line, which would require calculating
         how many rows it wrapped across at the current terminal width. Reset immediately after
         `rl.question()` resolves. Verified live: no reset code appears between the inverse-start
         and the echoed input text in the raw byte stream, confirming it renders as intended.
      4. **Extra blank line between input and response** — `readInput()` printed one blank line
         both before and after the prompt; removed the trailing one.
      98/98 tests pass (new: detail-truncation regression test), typecheck clean, all four
      confirmed live via pty (orange code correctly wraps `"Thought for..."` in the raw output).
- [x] User-reported (screenshot): streamed text was still landing directly onto a tool
      announcement with no line break — "...testing the API endpoints.⏺ Running shell command…".
      Real bug, a regression introduced by the per-turn ticker redesign: `redrawStatus()`'s
      "nothing to show" branch unconditionally set `interactiveAtLineStart = true` every time it
      ran — including when the per-turn ticker (fires every second, independent of what else is
      happening) landed *during active text streaming*, where the status area is legitimately
      empty (correctly cleared for the duration of the stream) but the cursor is very much *not*
      at line start (mid-sentence, no trailing newline yet). That false `true` then made the next
      tool-call's defensive-newline guard skip itself. Fixed by only claiming "at line start" on
      an actual transition (the region really did have something visible that just got cleared),
      not on every redundant no-op call. Not caught by any unit test — none of them run a ticker
      concurrently with active streaming, which is exactly the interaction that broke. 97/97 tests
      still pass, typecheck clean. Live-verified: zero occurrences of the squish pattern across a
      full multi-tool-call, multi-subagent run (checked precisely, distinguishing the real bug
      signature from an unrelated false-positive in the verification method itself — consecutive
      ephemeral redraw frames looking concatenated once ANSI codes are stripped for text search,
      which is expected and not a bug).

## `/goal` command — REPL route into the autonomous loop

**Why:** the task spec's core deliverable (a goal run crossing ≥2 context boundaries) only
exists in `runAgentLoop` (compaction + completion check). Users launch with no args and land in
the REPL, so the autonomous machinery was unreachable without a CLI-arg relaunch — a run of the
bookmarks demo crossed zero boundaries because of it. Decision (see session discussion): bare
prompt = chat turn; `/goal <text>` = autonomous run on the live session. No new colors — the
typed command already echoes in inverse video; the launch line uses the existing orange action
channel. Budget default (25K) unchanged — goal size, not the budget, is what makes a run cross
boundaries.

- [x] `src/loop/run.ts` — add optional `onGenerateStart` / `onContextUpdate` / `onCompaction`
      callbacks (all `| undefined`, exactOptionalPropertyTypes-safe), wired at the same points
      session.ts wires them (before each generate incl. the compaction merge; after each
      planning call's usage; after a compaction is checkpointed). Subagents and the CLI-goal
      path pass none — no behavior change there.
- [x] `src/loop/session.ts` — drop the latched `goalSeeded` flag; check goal.md on disk per
      message. A `/goal` run writes goal.md mid-session, and a stale latch would re-run chat
      intake on the next message and overwrite that goal.
- [x] `src/cli/render.ts` — `parseGoalCommand(input)`: pure, unit-testable. `/goal` → `""`,
      `/goal x` → `"x"`, anything else → `undefined`.
- [x] `src/cli.ts` —
  - extract `runGoalWithSession()` (shared runAgentLoop wiring; `runAutonomous` refactored to
    use it, rendering unchanged)
  - `renderMainJobEvent()`: `[main] tool: X` → permanent orange + tally; status lines (intake /
    compacting / validating) → ephemeral spinner verb
  - `runGoalFromRepl()`: orange launch line → clear goal.md + context.md (runAgentLoop's intake
    trusts an existing goal.md — without this the completion check would chase the chat's first
    message; the exact stale-goal bug being fixed) → run with REPL renderers → bold "Goal
    complete." + summary + orange stats line → always return to the prompt (AgentError = red
    line, session survives)
  - `readInput()` loops: `/goal` handled internally, only genuine chat lines reach the session
  - banner gains the `/goal` usage line
- [x] Tests: run.test.ts (callbacks fire: counts + argument shapes) and render.test.ts
      (parseGoalCommand cases)
- [x] Verify: `npm run typecheck`, `npm test`, diff review
- [x] Update `sprints/interactive-repl-ui.md` (REPL command surface changed)

**Review (post-implementation):** no git baseline exists yet (zero commits), so review was by
re-reading every changed region. Self-review caught one real bug pre-commit: the goal/context
clears sat *before* runGoalFromRepl's try block, so a disk failure there would have escaped and
killed the session — moved inside the try, honoring "a failed goal run ends the run, never the
session." One TS quirk fixed: `readInput` is a hoisted function declaration, so the
early-return narrowing on `session` was discarded inside it — bound a post-guard
`activeSession` with a comment. 106/106 tests pass (was 98 → +8: callback wiring, 3
parseGoalCommand cases, plus suite growth), typecheck clean, `tsx src/cli.ts --help` loads.
Behavior preserved where it must be: CLI-goal path identical (no new callbacks passed),
subagents untouched, pure-chat intake semantics unchanged (session.test.ts's 14 tests green).
Known consistent limitation: Ctrl+C during a `/goal` run defers until the run ends — same
semantics as an in-flight chat turn; abort plumbing through runAgentLoop is out of scope.
Live end-to-end `/goal` run (real API) intentionally left for the user's demo run.

**Follow-up (user request, live):** the submitted `/goal` line now lands in the permanent
transcript styled as a command — `/goal` bold (emphasis channel), `⏺ … — launching autonomous
run` orange (action channel), goal text on a tree-style `└` detail line truncated via the now
-exported `truncateDetail` (full text remains in the inverse echo above and in goal.md). Live
per-word styling while typing is impossible with readline-owned echo (all-or-nothing inverse
trick), so the effect lands at submit time. Bare-`/goal` usage line also bolds the command word.
Typecheck clean, 106/106 tests, styled-byte composition verified (no stray codes when piped).

## Review
*(filled in after each phase — diffs reviewed, behavior validated, alignment with sprint scope confirmed)*

## Audit-evidence persistence (sprints/audit-evidence-persistence.md)

**Why:** an external audit of the checkpoint/scratchpad spine found the no-data-loss core solid,
but a run dir alone couldn't answer three evidence questions: what configuration produced a run,
what each compaction boundary actually carried forward (only the last of N merges survived as a
file), and whether the context window actually climbed and reset. A fourth, cheap gap: no
definitive terminal-status record for the run as a whole. Scoped to exactly these 4 fixes, agreed
with the user; 2 smaller findings (assistant text, intake raw response) deliberately deferred and
documented as known limitations instead.

- [x] `checkpointLog.ts` — add `"usage"`/`"run_end"` to `CheckpointEventType` (additive).
- [x] `contextWindow.ts` — `writeCompactionSnapshot(runDir, index, contextMd)`, ordered/never-
      overwritten, alongside the unchanged overwrite-only `writeContext`.
- [x] `compactor.ts` — `CompactionResult` gains `usage: GenerateUsage` (was already returned by
      the SDK call and discarded).
- [x] `model/client.ts` — `AnthropicClient.getConfig()` getter (no `ModelClient` interface change).
- [x] New `context/runManifest.ts` — `writeRunManifest`/`updateRunManifest` (`run.json`
      read-merge-write) + `summarizeRunUsage` (derives compaction count + token totals from the
      checkpoint log itself, not a second accumulator).
- [x] `loop/run.ts` — `usage` checkpoint record after each planning call and the compaction merge;
      snapshot write + `contextSnapshot` on the compaction payload. `usageRecord()` exported for
      reuse.
- [x] `loop/session.ts` — identical wiring, importing `usageRecord` from `run.ts` (same
      cross-import precedent as `MUTATING_TOOLS` etc.).
- [x] `cli.ts` — initial `run.json` write in `setUpSession` (now takes a `mode` param); `/goal`
      paths (`runGoalWithSession`) and interactive-session-exit both call a shared
      `finalizeMainRun()` — patches `run.json` and appends a `run_end` checkpoint record, on both
      success and thrown-error paths.
- [x] Tests: `compactor.test.ts` (+2), `run.test.ts` (+2), `session.test.ts` (extended existing
      compaction test), new `runManifest.test.ts` (+6). 115/115 pass (was 106), typecheck clean.
- [x] Verify: `npm run typecheck`, `npm test`, full self-diff-review (no git baseline exists yet,
      same as prior sprints — reviewed by re-reading every changed region), `tsx src/cli.ts --help`
      loads clean.
- [x] Update `sprints/agent-architecture-approach.md` (§6 new gap-filled bullet, §9 file layout +
      `runManifest.ts`, `runs/` line mentions `run.json`/`compactions/`).

**Review:** no behavior change to compaction triggering, stall detection, or error taxonomy —
purely additive persistence around the existing loop, verified by all 106 pre-existing tests
passing unmodified before any new test was added. Live end-to-end API verification deliberately
left to the user (matches this repo's own established convention in the two sprints above, both
of which explicitly deferred real-API checks rather than spend budget the mocked test suite
already covers path-for-path) — recommended manual check: a short goal, low `--compaction-budget`,
scratch `--run-id`, then inspect `run.json` / `compactions/*.md` / the new `usage`/`run_end`
entries in `checkpoint.jsonl` by hand.
