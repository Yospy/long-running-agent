import { generateWithRetry, type ModelClient, type ModelMessage } from "../model/client.js";
import { renderTranscript } from "../context/contextWindow.js";
import { AgentError } from "../errors/taxonomy.js";

const COMPLETION_SCHEMA = {
  type: "object",
  properties: {
    complete: { type: "boolean" },
    unmetCriteria: { type: "array", items: { type: "string" } },
    reasoning: { type: "string" },
  },
  required: ["complete", "unmetCriteria", "reasoning"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT =
  "You are the completion checker for an autonomous agent. You do not do any work yourself. Given the goal's " +
  "explicit success criteria, the compacted working context, and the raw transcript since the last compaction, " +
  "decide strictly whether every criterion is objectively met. Do not give the agent the benefit of the doubt.";

export interface CompletionCheck {
  complete: boolean;
  unmetCriteria: string[];
  reasoning: string;
}

// Headroom for a detailed unmetCriteria/reasoning response — 1024 was observed truncating
// structured output live (stopReason "max_tokens" mid-JSON), which starved a subagent's entire
// iteration budget on repeated failed completion checks before it could recover. See
// loop/intake.ts's INTAKE_MAX_TOKENS for the identical failure pattern found first.
const COMPLETION_MAX_TOKENS = 2048;

/**
 * Separate check against explicit success criteria — the generating step never self-certifies
 * "done". Must see the raw buffer, not just context.md: context.md is only populated after the
 * first compaction, so a run that hasn't crossed that boundary yet would otherwise be judged
 * against an empty working context and could never pass.
 */
export async function checkCompletion(
  client: ModelClient,
  goalMd: string,
  contextMd: string,
  buffer: ModelMessage[],
): Promise<CompletionCheck> {
  const sections = [`## Goal and success criteria\n\n${goalMd.trim()}`];
  if (contextMd.trim().length > 0) {
    sections.push(`## Compacted working context\n\n${contextMd.trim()}`);
  }
  if (buffer.length > 0) {
    sections.push(`## Raw transcript since last compaction\n\n${renderTranscript(buffer)}`);
  }

  const result = await generateWithRetry(client, {
    systemPrompt: SYSTEM_PROMPT,
    tools: [],
    responseFormat: COMPLETION_SCHEMA,
    maxTokens: COMPLETION_MAX_TOKENS,
    thinking: false,
    messages: [{ role: "user", content: [{ type: "text", text: sections.join("\n\n") }] }],
  });

  if (result.stopReason === "max_tokens") {
    throw new AgentError({
      kind: "execution",
      message: `Completion check was truncated at the ${COMPLETION_MAX_TOKENS}-token limit before finishing its JSON output`,
      recoverable: true,
    });
  }

  const text = result.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") {
    throw new AgentError({
      kind: "execution",
      message: "Completion check produced no structured output",
      recoverable: true,
    });
  }

  try {
    return JSON.parse(text.text) as CompletionCheck;
  } catch (cause) {
    throw new AgentError({
      kind: "execution",
      message: "Completion check returned malformed JSON",
      recoverable: true,
      cause,
    });
  }
}
