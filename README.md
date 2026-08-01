# long-running-agent

An **infinite-running agent**: it runs a goal to completion, not until its context window fills.
When the window fills, the run compacts and continues — no goal-relevant information is
permanently lost. Everything (architecture, language, framework, storage, tooling) was left
open by the task spec; the decisions made are written up in
[`deliverables/APPROACH.md`](deliverables/APPROACH.md).

Working name in the code/CLI is **Rocket** (`rocket-agent`).

## Deliverables

This repo covers all four required deliverables:

1. **Working code** — this repository, runs end-to-end (see Quick start below).
2. **Demo video** — a complete goal run crossing at least two context-window boundaries.
3. **Approach document** — [`deliverables/APPROACH.md`](deliverables/APPROACH.md): design
   decisions, trade-offs, and what the spec left undefined.
4. **Use-case list** — [`deliverables/USE_CASES.md`](deliverables/USE_CASES.md): the classes of
   problem this agent is built to handle, with evidence from real runs.

For the full design write-up, architecture rationale, and phase-by-phase implementation log
(more detail than the polished approach doc), see
[`sprints/agent-architecture-approach.md`](sprints/agent-architecture-approach.md) and the other
files under [`sprints/`](sprints/).

## Quick start

```bash
npm install
cp .env.example .env   # then edit .env and set ANTHROPIC_API_KEY

npm run dev             # interactive REPL
```

Inside the REPL, either chat normally, or run a goal to completion autonomously:

```
› /goal Build a small command-line task tracker in TypeScript (Node built-ins only, no
  external dependencies)...
```

Or run a goal directly, non-interactively:

```bash
npx tsx src/cli.ts "<goal text>"
```

Useful flags (all optional — sensible defaults are baked in):

| Flag | Default | Meaning |
|---|---|---|
| `--model <id>` | client default | Anthropic model id |
| `--effort <level>` | `medium` | `low\|medium\|high\|xhigh\|max` |
| `--compaction-budget <tokens>` | `25000` | real-prompt-token threshold that triggers compaction |
| `--max-iterations <n>` | `120` | autonomous-mode top-level iteration cap |
| `--max-iterations-per-turn <n>` | `30` | interactive-mode per-turn iteration cap |
| `--subagent-max-iterations <n>` | `20` | per-subagent iteration cap |
| `--max-concurrent-subagents <n>` | `4` | cap on subagents running at once via `dispatch_subagents` |
| `--run-id <id>` | new per run | reuse an existing `runs/<id>/` dir instead of starting fresh |

Every run writes its full evidence trail to `runs/<run-id>/` (gitignored — this is generated
output, not source): a run manifest (`run.json`), an append-only `checkpoint.jsonl` (every tool
call, tool result, compaction, error), per-compaction context snapshots (`compactions/000N.md`),
and the run's own `goal.md`/`context.md`/`workspace/`.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test             # vitest
```

## Project layout

```
src/
├── cli.ts                  entrypoint — REPL + autonomous CLI-goal mode
├── loop/                   the state machine, intake, interactive-session driver, system prompt
├── context/                goal.md/context.md assembly, compaction, checkpoint log, run manifest, scratchpad
├── orchestrator/           subagent dispatch (dependsOn DAG, bounded concurrency, heartbeats)
├── tools/                  file ops, run_command, scratchpad reads, human-input, policy gate
├── validation/             completion-check against explicit success criteria
├── errors/                 structured error taxonomy
└── model/                  Anthropic SDK wrapper behind a provider-agnostic ModelClient interface
```

One file per architectural concept — the folder names are literally the sections of
`sprints/agent-architecture-approach.md`, so the design can be reconstructed from the tree alone.
