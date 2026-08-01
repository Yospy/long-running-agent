# Sprint: run_command workspace confinement + exit-code masking fix

Status: implemented.

## Motivation

Live-run investigation (two recent runs, both ending in `budgetExceeded`) found `run_command` is
the one tool with no real workspace confinement, and its exit code can misrepresent whether a
compound shell command actually succeeded. Two concrete, confirmed incidents:

1. A run reached outside its own workspace and invoked the *host Rocket project's own*
   `node_modules/.bin/tsc` via an absolute path, because its workspace (deliberately, per the
   goal's own "zero dependencies" requirement) had no local compiler. `run_command`'s own tool
   description already says "do not use... absolute paths... to reach files outside it," but
   `tools/policy.ts`'s enforced gate (`denyKnownDestructiveCommands`) only checks `..`-relative
   traversal and `rm`-with-escape — plain absolute paths were never checked at all. Compare
   `tools/fileTools.ts`'s `resolveWithinRoot`, which properly confines every other tool via
   `path.relative()`.
2. A run's own `npm test` genuinely passed (`EXIT=0`, confirmed in the captured output) but got
   reported to the model as a tool failure (`"Command exited with code 1"`), because the command
   chained a diagnostic `grep` after it in the same `;`-separated statement, that grep matched
   nothing (wrong symbol), and `runCommand.ts` reports the shell's own final exit code — which for
   `a; b; c` is always `c`'s, not `a`'s.

## Scope

1. **`tools/policy.ts`** — `denyKnownDestructiveCommands` (a static const) becomes
   `makeToolCallPolicy(workspaceRoot: string)` (a factory, matching the pattern every other tool in
   `tools/` already uses — `makeReadFileTool(workspaceRoot)` etc.). Adds a new, additive check
   (existing destructive-pattern checks are untouched, same regexes, same tests unmodified):
   for each `;`/`&&`/`||`/`|`/`&`-separated statement, reject if either `cd`'s target or the
   statement's own invoked command is an absolute path (or `~`) that resolves outside
   `workspaceRoot` (`path.relative` containment check, same approach as `resolveWithinRoot`).
   Deliberately narrow (not "reject any absolute-path token anywhere") to avoid false positives on
   legitimate patterns like `curl -o /dev/null` or a URL embedded in a larger token.
2. **`tools/runCommand.ts`** — spawn via `/bin/bash -c 'set -o pipefail; <command>'` instead of the
   default shell, so a failing command earlier in a `|` pipeline (e.g. `tsc --noEmit | tail -30`)
   is reflected in the reported exit code instead of being masked by the last stage. This does
   *not* fix `;`-chain masking (each `;`-separated statement legitimately has its own independent
   exit code — that's normal shell semantics, not a bug to "fix" by rewriting the model's chosen
   command) — instead, the tool's own description is updated to explicitly warn about this and
   tell the model to put its own exit-code check immediately after the command it cares about, not
   after further diagnostics.
3. **`cli.ts`** — both tool-registry construction sites (`orchestratorTools`/`subagentTools` in
   `buildToolRegistries`) call `makeToolCallPolicy(session.workspaceRoot)` instead of importing the
   old static const.
4. Tests: extend `policy.test.ts` for the new checks; new `runCommand.test.ts` (none existed) that
   spawns real subprocesses to confirm pipefail is actually active and confinement actually
   rejects/allows the right things.

## Verification

- `npm run typecheck` clean, `npm test`: 125/125 pass (was 106 before this + the prior
  audit-evidence sprint combined; +19 here: 6 new absolute-path-escape cases in `policy.test.ts`,
  5 new `runCommand.test.ts` — none existed before).
- Live direct test (`tsx src/cli.ts "<goal>" --run-id verify-fix-...`), a small TS task deliberately
  shaped like the original incident (no local compiler, success criteria require `tsc --noEmit`
  clean): the agent correctly ran `npm init -y && npm install --save-dev typescript @types/node`
  *inside its own workspace* and invoked the compiler via a relative path
  (`./node_modules/.bin/tsc`) — never triggered the new policy check, because it made the right
  choice this time. Goal completed (exit 0), 3/3 tests passing, `run.json` end-state accurate
  (`finalStatus: "done"`, 12 iterations, 0 compactions — budget of 12,000 never hit for a task this
  small, consistent with the project's own earlier calibration finding).
- **One real trade-off surfaced live, worth knowing:** `pipefail` also makes a `command | head -N`
  pipeline report failure when `head` truncates a long stream before `command` finishes writing —
  `command` gets `SIGPIPE` (exit 141), and pipefail reports that instead of `head`'s own (usually
  0) exit code. This is a well-known, classic `pipefail` + `head` gotcha, not specific to this
  change. Confirmed live: the agent piped `tsc --traceResolution` through `grep | head -20`, got a
  141, and simply re-ran the compiler directly without the trace next — handled it gracefully, no
  wasted iterations. Documented here rather than special-cased (e.g. suppressing SIGPIPE when the
  pipe ends in `head`/`tail`) — that heuristic would add real complexity for a cosmetic false
  positive that the model already recovers from cleanly.

## Non-goals

- Not a real OS-level sandbox (container/chroot) — same "tripwire, not a boundary" philosophy
  `policy.ts`'s own docblock already states; a determined adversarial input can still route around
  string-level checks. This raises the bar for the realistic failure mode actually observed
  (an agent reaching for tooling it doesn't have), not defends against attack.
- Not attempting to "fix" `;`-chain exit-code semantics in code — that's normal shell behavior: a
  chain like `test; echo done` deliberately wants `echo`'s exit code. Fixed via tool-description
  guidance instead, which is the right lever for a model behavior/judgment issue, not a bug.
