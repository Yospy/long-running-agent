import { generateWithRetry, type ModelClient } from "../model/client.js";
import { AgentError } from "../errors/taxonomy.js";

const INTAKE_SCHEMA = {
  type: "object",
  properties: {
    restatedGoal: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    successCriteria: { type: "array", items: { type: "string" } },
  },
  required: ["restatedGoal", "assumptions", "successCriteria"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT =
  "You are the intake step for an autonomous, unattended agent. Given a goal, restate it precisely, list every " +
  "blocking ambiguity as a best-effort assumption (the agent cannot wait for a human), and write explicit, " +
  "objectively checkable success criteria. Do not do any of the actual work here.";

// Headroom for a verbose assumptions/successCriteria list — 2048 was observed truncating structured
// output on subagent intake calls in a live run (stopReason "max_tokens" mid-JSON), which surfaced
// as a confusing "malformed JSON" parse failure rather than the real cause.
const INTAKE_MAX_TOKENS = 4096;

interface IntakeResponse {
  restatedGoal: string;
  assumptions: string[];
  successCriteria: string[];
}

/** One-shot, non-blocking clarification phase. Produces the initial goal.md content. */
export async function runIntake(client: ModelClient, rawGoal: string): Promise<string> {
  const result = await generateWithRetry(client, {
    systemPrompt: SYSTEM_PROMPT,
    tools: [],
    responseFormat: INTAKE_SCHEMA,
    maxTokens: INTAKE_MAX_TOKENS,
    thinking: false,
    messages: [{ role: "user", content: [{ type: "text", text: rawGoal }] }],
  });

  if (result.stopReason === "max_tokens") {
    throw new AgentError({
      kind: "execution",
      message: `Intake response was truncated at the ${INTAKE_MAX_TOKENS}-token limit before finishing its JSON output`,
      recoverable: true,
    });
  }

  const text = result.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") {
    throw new AgentError({ kind: "execution", message: "Intake produced no structured output", recoverable: false });
  }

  let parsed: IntakeResponse;
  try {
    parsed = JSON.parse(text.text) as IntakeResponse;
  } catch (cause) {
    throw new AgentError({ kind: "execution", message: "Intake returned malformed JSON", recoverable: true, cause });
  }

  return renderGoalMd(parsed);
}

function renderGoalMd(parsed: IntakeResponse): string {
  const assumptions = parsed.assumptions.length > 0 ? parsed.assumptions.map((a) => `- ${a}`).join("\n") : "(none)";
  const criteria = parsed.successCriteria.map((c) => `- [ ] ${c}`).join("\n");
  return ["# Goal", "", parsed.restatedGoal, "", "## Assumptions", "", assumptions, "", "## Success criteria", "", criteria, ""].join(
    "\n",
  );
}
