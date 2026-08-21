import { generateWithRetry, type GenerateUsage, type ModelClient, type ModelMessage } from "../model/client.js";
import { renderTranscript } from "./contextWindow.js";
import { AgentError } from "../errors/taxonomy.js";

const SYSTEM_PROMPT =
  "You compact the working memory of an autonomous agent. You do not do any of the agent's work yourself. " +
  "Merge the previous working context and the raw transcript since the last compaction into ONE new working-context " +
  "document. Never just append — genuinely merge, so the document stays roughly constant size across many compactions. " +
  "Preserve every fact still relevant to finishing the goal; drop anything already superseded or resolved.";

const TEMPLATE_INSTRUCTIONS =
  "Respond with exactly these five sections, in this order, as markdown headings:\n" +
  "## Goal (restated)\n## Constraints and decisions made\n## Unresolved errors\n## Completed steps\n## Next planned step";

export interface CompactionResult {
  contextMd: string;
  usage: GenerateUsage;
}

// Headroom for merging a large raw transcript (or a prior context.md plus a long stretch of new
// work) into one document — 4096 left no margin and, unlike intake/completion, a truncated
// compaction has no JSON.parse step to fail loudly on, so it would otherwise be silently accepted.
const COMPACTION_MAX_TOKENS = 8192;

/** Whether the last call's real prompt size (not an estimate) has hit the configured budget. */
export function shouldCompact(usage: GenerateUsage, budgetTokens: number): boolean {
  const totalPromptTokens = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  return totalPromptTokens >= budgetTokens;
}

export async function compact(
  client: ModelClient,
  goalMd: string,
  previousContextMd: string,
  buffer: ModelMessage[],
): Promise<CompactionResult> {
  const sections = [`## Goal\n\n${goalMd.trim()}`];
  if (previousContextMd.trim().length > 0) {
    sections.push(`## Previous working context\n\n${previousContextMd.trim()}`);
  }
  sections.push(`## Raw transcript since last compaction\n\n${renderTranscript(buffer)}`);
  sections.push(TEMPLATE_INSTRUCTIONS);
  const prompt = sections.join("\n\n");

  // One retry at double the budget before giving up. `thinking: false` (above) removes one source
  // of truncation, but not all of it — a genuinely large transcript can still hit even a generous
  // fixed cap. Compaction failing is unlike intake/completion failing: it aborts the whole job
  // (see loop/run.ts's catch around this call), on the one path that exists specifically to
  // protect context continuity. A single larger-budget retry is a proportionate, minimal escalation
  // before that hard failure — not a guarantee, but meaningfully better than none.
  let result = await generateWithRetry(client, {
    systemPrompt: SYSTEM_PROMPT,
    tools: [],
    maxTokens: COMPACTION_MAX_TOKENS,
    thinking: false,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });

  if (result.stopReason === "max_tokens") {
    result = await generateWithRetry(client, {
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      maxTokens: COMPACTION_MAX_TOKENS * 2,
      thinking: false,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });
  }

  // Checked before trusting the text at all: a truncated compaction would otherwise be silently
  // accepted as the new context.md — the "## Next planned step" section renders last per
  // TEMPLATE_INSTRUCTIONS, so it's the first thing a truncation would cut, right when it matters
  // most. That's the exact silent-data-loss failure mode this whole project exists to prevent, so
  // this must fail loudly instead of returning a partial document.
  if (result.stopReason === "max_tokens") {
    throw new AgentError({
      kind: "execution",
      message: `Compaction was truncated even after retrying at ${COMPACTION_MAX_TOKENS * 2} tokens`,
      recoverable: true,
    });
  }

  const text = result.content.find((block) => block.type === "text");
  if (!text || text.type !== "text" || text.text.trim().length === 0) {
    throw new AgentError({ kind: "execution", message: "Compaction produced no summary text", recoverable: false });
  }
  return { contextMd: text.text.trim(), usage: result.usage };
}
