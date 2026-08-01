import { generateWithRetry, type GenerateUsage, type ModelClient, type ModelMessage, type StreamEvent } from "../model/client.js";
import type { ToolContext, ToolRegistry } from "../tools/registry.js";
import type { CheckpointLog } from "../context/checkpointLog.js";
import { pointerToString, routeToolOutput, type Scratchpad } from "../context/scratchpad.js";
import {
  assembleMessages,
  readContext,
  readGoal,
  writeCompactionSnapshot,
  writeContext,
  writeGoal,
} from "../context/contextWindow.js";
import { compact, shouldCompact } from "../context/compactor.js";
import { checkCompletion } from "../validation/completion.js";
import { runIntake } from "./intake.js";
import { assertValidTransition, type AgentPhase } from "./state.js";
import { AgentError } from "../errors/taxonomy.js";

export interface RunLoopParams {
  client: ModelClient;
  tools: ToolRegistry;
  checkpointLog: CheckpointLog;
  scratchpad: Scratchpad;
  runDir: string;
  jobId: string;
  objective: string;
  systemPrompt: string;
  compactionBudgetTokens: number;
  maxIterations: number;
  onIteration?: (() => void) | undefined;
  onEvent?: ((line: string) => void) | undefined;
  /** Fired right before each generate() call, including the compaction merge — lets a live UI
   * show activity during the API round-trip (mirrors session.ts's wiring). Only the REPL's
   * `/goal` path passes this; subagents and the CLI-goal path pass nothing. */
  onGenerateStart?: (() => void) | undefined;
  /** Real prompt-token reading after each planning call (and a 0 reset after compaction). */
  onContextUpdate?: ((usedTokens: number, budgetTokens: number) => void) | undefined;
  /** Fired once a compaction is durably on disk (context.md written, checkpoint appended) —
   * the merged document, how many raw turns went into it, and where the original archived. */
  onCompaction?: ((contextMd: string, mergedTurns: number, archivePointer: string) => void) | undefined;
  /** Live token-level updates (including thinking_delta) for the main planning call only — not
   * wired into subagents, whose parallel output would interleave into an unreadable single
   * terminal stream. Subagents still get their turn's answer text surfaced via onEvent instead,
   * once each turn completes (see the onStreamEvent-absent branch below) — coherent per-turn
   * lines instead of live tokens, and text only, not the thinking trace (which stays opaque by
   * design — see ContentBlock's "opaque" variant) — but not silent the way they were before. */
  onStreamEvent?: ((event: StreamEvent) => void) | undefined;
}

export interface RunLoopResult {
  summary: string;
}

// Exported for reuse by loop/session.ts's interactive turn loop, which applies the same
// per-turn stall detection — the constants and the definition of "progress" are shared, not
// mode-specific.
export const TACTICAL_STALL_WINDOW = 3;
export const STRATEGIC_STALL_WINDOW = 5;

// Caps a single turn's displayed (not checkpointed — this only affects terminal output) text so
// one job's long final report doesn't dominate the terminal while other jobs are still working.
const MAX_EMITTED_TEXT_CHARS = 2_000;

// Read-only tools (read_file, list_dir, search, read_scratchpad, request_human_input) can
// succeed indefinitely without the goal ever advancing — only a mutating call counts as progress
// for strategic-stall purposes.
export const MUTATING_TOOLS = new Set(["write_file", "edit_file", "run_command", "dispatch_subagents"]);

/**
 * The state machine driver: intake once, then planning/compacting/executing_tool/
 * validating_completion until the goal is done or the loop gives up. Bounded by progress
 * (stall detection) and a hard iteration cap, never by wall-clock time.
 */
export async function runAgentLoop(params: RunLoopParams): Promise<RunLoopResult> {
  const { client, tools, checkpointLog, scratchpad, runDir, jobId, systemPrompt } = params;
  const emit = params.onEvent ?? ((): void => {});
  const toolContext: ToolContext = { runDir, jobId };

  emit(`[${jobId}] intake`);
  // Idempotent: a goal.md already on disk (e.g. this jobId's runDir was reused) is trusted as-is,
  // rather than re-run intake and overwrite an in-progress goal.
  const existingGoalMd = await readGoal(runDir);
  if (existingGoalMd.trim().length === 0) {
    try {
      await writeGoal(runDir, await runIntake(client, params.objective));
    } catch (cause) {
      await checkpointLog.append(jobId, "error", toErrorRecord(cause));
      throw cause instanceof AgentError ? cause : toAgentError(cause);
    }
  }
  await checkpointLog.append(jobId, "state_transition", { phase: "intake" });
  let phase: AgentPhase = nextPhase("intake", "planning");

  let buffer: ModelMessage[] = [];
  let lastUsage: GenerateUsage | undefined;
  const recentToolCallHashes: string[] = [];
  let consecutiveIterationsWithoutProgress = 0;
  let compactionIndex = 0;

  for (let iteration = 0; iteration < params.maxIterations; iteration++) {
    params.onIteration?.();

    if (phase === "validating_completion") {
      const contextMd = await readContext(runDir);
      const goalMd = await readGoal(runDir);
      emit(`[${jobId}] validating completion`);

      let check;
      try {
        check = await checkCompletion(client, goalMd, contextMd, buffer);
      } catch (cause) {
        await checkpointLog.append(jobId, "error", toErrorRecord(cause));
        buffer.push({
          role: "user",
          content: [
            { type: "text", text: "The completion check failed to run. Assume the goal is not yet complete and continue working." },
          ],
        });
        phase = nextPhase(phase, "planning");
        continue;
      }
      await checkpointLog.append(jobId, "state_transition", { phase, check });

      if (check.complete) {
        phase = nextPhase(phase, "done");
        break;
      }

      buffer.push({
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Completion check failed. Unmet criteria:\n${check.unmetCriteria.map((c) => `- ${c}`).join("\n")}\n\n` +
              check.reasoning,
          },
        ],
      });
      phase = nextPhase(phase, "planning");
      continue;
    }

    // phase === "planning"
    let contextMd = await readContext(runDir);
    const goalMd = await readGoal(runDir);

    if (lastUsage && shouldCompact(lastUsage, params.compactionBudgetTokens)) {
      phase = nextPhase(phase, "compacting");
      emit(`[${jobId}] compacting (prompt hit the ${params.compactionBudgetTokens}-token budget)`);
      try {
        // Archive the exact pre-compaction buffer before it's discarded — the LLM merge below is
        // what the agent recites going forward, but the original is still one pointer away if
        // that summary ever misjudges relevance. Never actually lost, only summarized.
        const archivePointer = await scratchpad.write(jobId, JSON.stringify(buffer, null, 2));
        const archivePointerString = pointerToString(archivePointer);
        // compact() makes its own real generate() call outside the planning call — without
        // this, a live UI would show nothing for the duration of the merge (session.ts does
        // the same for its own compaction path).
        params.onGenerateStart?.();
        const compaction = await compact(client, goalMd, contextMd, buffer);
        contextMd = compaction.contextMd;
        await writeContext(runDir, contextMd);
        // Ordered, never-overwritten copy alongside the overwrite-only context.md — otherwise
        // only the *last* of this run's merged summaries survives as a file.
        const contextSnapshot = await writeCompactionSnapshot(runDir, compactionIndex++, contextMd);
        await checkpointLog.append(jobId, "compaction", {
          mergedTurns: buffer.length,
          archivePointer: archivePointerString,
          contextSnapshot,
        });
        await checkpointLog.append(jobId, "usage", usageRecord("compaction", compaction.usage, params.compactionBudgetTokens));
        params.onCompaction?.(contextMd, buffer.length, archivePointerString);
        buffer = [];
        lastUsage = undefined;
        params.onContextUpdate?.(0, params.compactionBudgetTokens);
        phase = nextPhase(phase, "planning");
      } catch (cause) {
        // A failed merge risks silently losing the one thing this whole design protects —
        // stop cleanly and surface it rather than guess at a partial merge.
        await checkpointLog.append(jobId, "error", toErrorRecord(cause));
        phase = nextPhase(phase, "error");
        break;
      }
    }

    const messages = assembleMessages(goalMd, contextMd, buffer);

    let result;
    try {
      params.onGenerateStart?.();
      result = await generateWithRetry(client, {
        systemPrompt,
        tools: tools.definitions(),
        messages,
        onStreamEvent: params.onStreamEvent,
      });
    } catch (cause) {
      await checkpointLog.append(jobId, "error", toErrorRecord(cause));
      phase = nextPhase(phase, "error");
      break;
    }
    lastUsage = result.usage;
    await checkpointLog.append(jobId, "usage", usageRecord("planning", result.usage, params.compactionBudgetTokens));
    params.onContextUpdate?.(usedTokens(result.usage), params.compactionBudgetTokens);
    buffer.push({ role: "assistant", content: result.content });

    // The main job's own answer text is already visible live via onStreamEvent's raw token
    // deltas (note: that's the model's text content, not its extended-thinking trace — thinking
    // stays opaque by design, see ContentBlock's "opaque" variant). Every other job (every
    // subagent) has no live view at all — without this, its terminal presence is just bare tool
    // names with nothing explaining why. Emitting the finished text per turn (not per token)
    // avoids the interleaved-garbage problem that ruled out live streaming for concurrent
    // subagents, while still surfacing what it's doing and why. Emitted per line (not as one
    // multi-line block) so every line carries its own [jobId] prefix — several subagents' turns
    // can complete in close succession, and an unprefixed continuation line would be as ambiguous
    // as the interleaving this was meant to avoid. Capped, since an uncapped final-report-length
    // block would otherwise dominate the terminal while other jobs are still working.
    if (!params.onStreamEvent) {
      for (const block of result.content) {
        if (block.type !== "text") continue;
        const text = block.text.trim();
        if (text.length === 0) continue;
        const truncated = text.length > MAX_EMITTED_TEXT_CHARS ? `${text.slice(0, MAX_EMITTED_TEXT_CHARS)}… [truncated]` : text;
        for (const line of truncated.split("\n")) {
          if (line.trim().length > 0) emit(`[${jobId}] ${line}`);
        }
      }
    }

    if (result.stopReason === "refusal") {
      await checkpointLog.append(jobId, "error", { refusal: true });
      phase = nextPhase(phase, "error");
      break;
    }

    if (result.stopReason === "max_tokens") {
      await checkpointLog.append(jobId, "error", { truncated: true });
      buffer.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "Your previous response was truncated by the token limit. Continue, preferring more concise responses or fewer simultaneous tool calls.",
          },
        ],
      });
      continue;
    }

    if (result.toolCalls.length === 0) {
      phase = nextPhase(phase, "validating_completion");
      continue;
    }

    phase = nextPhase(phase, "executing_tool");
    const toolResults: ModelMessage["content"] = [];
    let iterationAdvancedGoal = false;

    for (const call of result.toolCalls) {
      emit(`[${jobId}] tool: ${call.name}`);
      await checkpointLog.append(jobId, "tool_call", { name: call.name, input: call.input });

      try {
        const rawOutput = await tools.dispatch(call.name, call.input, toolContext);
        const routed = await routeToolOutput(scratchpad, jobId, rawOutput);
        await checkpointLog.append(jobId, "tool_result", {
          name: call.name,
          output: routed.text,
          scratchPointer: routed.scratchPointer,
        });
        toolResults.push({ type: "tool_result", toolUseId: call.id, content: routed.text, isError: false });
        if (MUTATING_TOOLS.has(call.name)) iterationAdvancedGoal = true;
        recentToolCallHashes.push(`${call.name}:${JSON.stringify(call.input)}`);
      } catch (cause) {
        const agentError = cause instanceof AgentError ? cause : toAgentError(cause);
        await checkpointLog.append(jobId, "tool_result", { name: call.name, error: agentError.toLogRecord() });
        toolResults.push({ type: "tool_result", toolUseId: call.id, content: agentError.toModelText(), isError: true });
      }
    }

    buffer.push({ role: "user", content: toolResults });

    consecutiveIterationsWithoutProgress = iterationAdvancedGoal ? 0 : consecutiveIterationsWithoutProgress + 1;
    if (consecutiveIterationsWithoutProgress >= STRATEGIC_STALL_WINDOW) {
      await checkpointLog.append(jobId, "error", { stall: "strategic" });
      phase = nextPhase(phase, "error");
      break;
    }

    if (recentToolCallHashes.length > TACTICAL_STALL_WINDOW) recentToolCallHashes.shift();
    if (
      recentToolCallHashes.length === TACTICAL_STALL_WINDOW &&
      recentToolCallHashes.every((hash) => hash === recentToolCallHashes[0])
    ) {
      buffer.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "You've repeated the same tool call with the same input several times without new progress. Stop and try a fundamentally different approach.",
          },
        ],
      });
      recentToolCallHashes.length = 0;
    }

    phase = nextPhase(phase, "planning");
  }

  if (phase !== "done" && phase !== "error") {
    await checkpointLog.append(jobId, "error", { budgetExceeded: true, maxIterations: params.maxIterations });
    phase = nextPhase(phase, "error");
  }

  if (phase === "error") {
    throw new AgentError({
      kind: "budget_exceeded",
      message: `Job ${jobId} did not reach "done" (last phase: error)`,
      recoverable: false,
    });
  }

  const finalContext = await readContext(runDir);
  return {
    summary: finalContext || "Goal completed; no compaction occurred, see the checkpoint log for the full transcript.",
  };
}

function nextPhase(from: AgentPhase, to: AgentPhase): AgentPhase {
  assertValidTransition(from, to);
  return to;
}

// The real prompt size — same formula as compactor.ts's shouldCompact and session.ts.
function usedTokens(usage: GenerateUsage): number {
  return usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
}

// Shared shape for the "usage" checkpoint record — exported and reused by session.ts's mirrored
// call site (same cross-import pattern this file already uses for MUTATING_TOOLS/
// STRATEGIC_STALL_WINDOW/TACTICAL_STALL_WINDOW above), so a reader doesn't need to special-case
// which loop produced a given entry.
export function usageRecord(phase: "planning" | "compaction", usage: GenerateUsage, budgetTokens: number): Record<string, unknown> {
  return {
    phase,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    totalPromptTokens: usedTokens(usage),
    budgetTokens,
  };
}

function toAgentError(cause: unknown): AgentError {
  return new AgentError({
    kind: "execution",
    message: cause instanceof Error ? cause.message : "Unknown tool failure",
    recoverable: true,
    cause,
  });
}

function toErrorRecord(cause: unknown): Record<string, unknown> {
  if (cause instanceof AgentError) return cause.toLogRecord();
  return { message: cause instanceof Error ? cause.message : String(cause) };
}
