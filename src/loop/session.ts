import {
  generateWithRetry,
  type GenerateUsage,
  type ModelClient,
  type ModelMessage,
  type StreamEvent,
} from "../model/client.js";
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
import { runIntake } from "./intake.js";
import { MUTATING_TOOLS, STRATEGIC_STALL_WINDOW, TACTICAL_STALL_WINDOW, usageRecord } from "./run.js";
import { AgentError } from "../errors/taxonomy.js";

export interface InteractiveSessionParams {
  client: ModelClient;
  tools: ToolRegistry;
  checkpointLog: CheckpointLog;
  scratchpad: Scratchpad;
  runDir: string;
  jobId: string;
  systemPrompt: string;
  compactionBudgetTokens: number;
  maxIterationsPerTurn: number;
  /** Returns the next line of user input, or null when the session should end (exit/EOF/Ctrl+C). */
  readInput: () => Promise<string | null>;
  /** The turn's final text response, once the model has no more tool calls to make. */
  onTurnResponse: (text: string) => void;
  /** Reported instead of throwing — a turn-level failure returns control to the input prompt
   * rather than ending the whole session, since (unlike the unattended autonomous mode) a human
   * is right here to decide what to do next. */
  onTurnError?: ((message: string) => void) | undefined;
  onEvent?: ((line: string) => void) | undefined;
  onToolCall?: ((name: string, input: unknown) => void) | undefined;
  /** Live token-level updates during each generate() call — a turn's own thinking/answer text
   * can take a real API round-trip (seconds to tens of seconds) with nothing else to show in the
   * meantime otherwise. Unlike the autonomous mode, tool_use_start events are expected to be
   * ignored by the caller here — onToolCall (above) already announces each call once, richly
   * (name + its key input field), once the call is fully parsed; showing it a second time, bare,
   * as soon as streaming detects the block starting would just duplicate it. */
  onStreamEvent?: ((event: StreamEvent) => void) | undefined;
  onContextUpdate?: ((usedTokens: number, budgetTokens: number) => void) | undefined;
  onCompaction?: ((contextMd: string, mergedTurns: number, archivePointer: string) => void) | undefined;
  /** Fired right before each generate() call — lets the caller show something (e.g. an elapsed-
   * time indicator) during the real API round-trip, before there's any streamed content yet to
   * show instead. */
  onGenerateStart?: (() => void) | undefined;
  /** Fired once per turn, after it's done — whatever the outcome (a normal response, an error,
   * a stall, or hitting the iteration cap). Turn-level bookkeeping (elapsed time, tool tally)
   * belongs to the caller, not this module, so this is just a signal that a turn is now over. */
  onTurnEnd?: (() => void) | undefined;
}

/**
 * Turn-based driver for an interactive session — the human is present, so unlike
 * runAgentLoop's autonomous mode there's no separate completion check: a turn simply ends when
 * the model responds with no more tool calls, control returns to the human, and their next
 * message continues the same buffer/context. Compaction, tool dispatch, and stall detection are
 * the same mechanisms the autonomous loop uses, just scoped per turn instead of per whole run.
 */
export async function runInteractiveSession(params: InteractiveSessionParams): Promise<void> {
  const { client, tools, checkpointLog, scratchpad, runDir, jobId, systemPrompt } = params;
  const emit = params.onEvent ?? ((): void => {});
  const toolContext: ToolContext = { runDir, jobId };

  let buffer: ModelMessage[] = [];
  let lastUsage: GenerateUsage | undefined;
  let compactionIndex = 0;

  // Establishes the budget visually before any real usage exists — not a measurement, a starting
  // point, matching the same "0 / budget" reading a compaction resets back to.
  params.onContextUpdate?.(0, params.compactionBudgetTokens);

  for (;;) {
    const userInput = await params.readInput();
    if (userInput === null) return;
    const trimmed = userInput.trim();
    if (trimmed.length === 0) continue;
    if (trimmed === "exit" || trimmed === "quit") return;

    // goal.md on disk — not a latched in-memory flag — decides whether intake runs: a `/goal`
    // autonomous run (cli.ts) writes goal.md mid-session, and trusting a stale "already seeded"
    // flag here would re-run intake on the next chat message and overwrite that goal.
    if ((await readGoal(runDir)).trim().length === 0) {
      try {
        // The very first message of a session hits this before anything else — without firing
        // the same signal the turn loop's own generate() calls use, there's nothing to show
        // (intake doesn't stream) and the screen just sits blank until intake resolves.
        params.onGenerateStart?.();
        await writeGoal(runDir, await runIntake(client, trimmed));
      } catch (cause) {
        await checkpointLog.append(jobId, "error", toErrorRecord(cause));
        params.onTurnError?.(`Could not process that message: ${messageOf(cause)}`);
        continue;
      }
    }

    buffer.push({ role: "user", content: [{ type: "text", text: trimmed }] });
    await checkpointLog.append(jobId, "state_transition", { phase: "planning", turnStart: true });

    const recentToolCallHashes: string[] = [];
    let consecutiveIterationsWithoutProgress = 0;
    let turnEnded = false;

    for (let iteration = 0; iteration < params.maxIterationsPerTurn && !turnEnded; iteration++) {
      let contextMd = await readContext(runDir);
      const goalMd = await readGoal(runDir);

      if (lastUsage && shouldCompact(lastUsage, params.compactionBudgetTokens)) {
        emit(`[${jobId}] compacting (prompt hit the ${params.compactionBudgetTokens}-token budget)`);
        try {
          const archivePointer = await scratchpad.write(jobId, JSON.stringify(buffer, null, 2));
          const archivePointerString = pointerToString(archivePointer);
          // compact() makes its own real generate() call, outside the turn loop's own — without
          // this, whatever activity was showing before (e.g. the last tool call) would just sit
          // there stale for however long the merge takes, rather than reflecting what's actually
          // happening.
          params.onGenerateStart?.();
          const compaction = await compact(client, goalMd, contextMd, buffer);
          contextMd = compaction.contextMd;
          await writeContext(runDir, contextMd);
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
        } catch (cause) {
          await checkpointLog.append(jobId, "error", toErrorRecord(cause));
          params.onTurnError?.(`Compaction failed, this turn was cut short: ${messageOf(cause)}`);
          turnEnded = true;
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
        params.onTurnError?.(`This turn failed: ${messageOf(cause)}`);
        turnEnded = true;
        break;
      }
      lastUsage = result.usage;
      await checkpointLog.append(jobId, "usage", usageRecord("planning", result.usage, params.compactionBudgetTokens));
      params.onContextUpdate?.(usedTokens(result.usage), params.compactionBudgetTokens);
      buffer.push({ role: "assistant", content: result.content });

      if (result.stopReason === "refusal") {
        await checkpointLog.append(jobId, "error", { refusal: true });
        params.onTurnError?.("The model declined to continue this turn.");
        turnEnded = true;
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
        // When streaming, this exact text was already shown live via text_delta events —
        // printing it again here would just duplicate it (same reasoning as loop/run.ts's
        // equivalent guard for the autonomous mode's main job).
        if (!params.onStreamEvent) {
          const text = result.content
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text.trim())
            .filter((text) => text.length > 0)
            .join("\n\n");
          params.onTurnResponse(text.length > 0 ? text : "(no response text)");
        }
        turnEnded = true;
        break;
      }

      const toolResults: ModelMessage["content"] = [];
      let iterationAdvancedGoal = false;

      for (const call of result.toolCalls) {
        if (params.onToolCall) params.onToolCall(call.name, call.input);
        else emit(`[${jobId}] tool: ${call.name}`);
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
        params.onTurnError?.("Stopped this turn: several tool calls in a row made no real progress.");
        turnEnded = true;
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
    }

    if (!turnEnded) {
      params.onTurnError?.(`This turn hit its ${params.maxIterationsPerTurn}-iteration cap without finishing — try a narrower request.`);
    }
    params.onTurnEnd?.();
  }
}

function usedTokens(usage: GenerateUsage): number {
  return usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toAgentError(cause: unknown): AgentError {
  return new AgentError({ kind: "execution", message: messageOf(cause), recoverable: true, cause });
}

function toErrorRecord(cause: unknown): Record<string, unknown> {
  if (cause instanceof AgentError) return cause.toLogRecord();
  return { message: messageOf(cause) };
}
