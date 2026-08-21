# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Pre-implementation. This repo currently contains only `task.pdf` (the spec) and `CLAUDE.md`.
No language, framework, or storage has been chosen yet — those are open decisions per the spec itself
("What you decide: Everything - architecture, language, framework, storage, tooling").
Do not assume the rest of the stack; confirm with the user before scaffolding.

## Decisions made

- **Main agent model: Anthropic (Claude).** The agent that runs the infinite goal loop uses
  Anthropic's Claude models via the Anthropic API. The API key is read from the `ANTHROPIC_API_KEY`
  environment variable (see `.env`, which is gitignored — copy `.env.example` if one is added).
  This does not pin a specific Claude model version; that can be parameterized later.

This file will be rewritten once real code and commands exist — treat the "Status" and
"Task spec" sections below as authoritative until then, not the placeholders they'll replace.

## Task spec (source of truth: `task.pdf`)

Build an **infinite-running agent**: the agent runs until its goal is complete, not until
its context window fills. When the context window fills, the run must continue without
interruption, and no goal-relevant information may be permanently lost. The core problem
being tested is context continuity across a compaction/checkpoint boundary, not the agent
loop itself.

**Deliverables (all required):**
1. Working code — runs end-to-end
2. Demo video — a complete goal run crossing at least two context window boundaries
3. Approach document — design decisions, trade-offs, and what's missing from the spec
4. Use-case list — the use cases attempted with this agent

**Evaluation rubric:**
- Does it work end-to-end, including through context boundaries
- System design — clean, extensible boundaries
- Gap-filling — what was identified as missing from the spec, and how it was handled
- Code quality — clear boundaries, accurate naming, navigable by someone unfamiliar
- Approach document — real decisions, not post-hoc justification
- Error handling — production-level, not happy-path only

## Repository note

The parent directory `~/Desktop` is a pre-existing git repo (unrelated `CodeReviewerWebsite`
project) with a large set of unrelated, unstaged pending deletions. This `Rocket/` folder
should get its own independent git history rather than being committed through the parent
repo, to avoid entangling unrelated changes.
