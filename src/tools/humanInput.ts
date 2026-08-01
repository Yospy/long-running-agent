import { z } from "zod";
import type { Tool } from "./registry.js";

const requestHumanInputSchema = z.object({ question: z.string() });

/**
 * Rare escape hatch for genuine blockers. The agent runs unattended, so this never pauses the
 * run — it's advisory only, and every call is already captured in the checkpoint log like any
 * other tool call, giving a human reviewer a searchable trail of every place the agent had to guess.
 */
export const requestHumanInputTool: Tool<z.infer<typeof requestHumanInputSchema>> = {
  definition: {
    name: "request_human_input",
    description:
      "Flag a genuine blocker for human review (e.g. a missing credential or authorization the agent doesn't have). " +
      "No human is available synchronously, so this does not pause the run. Use only for real blockers, not routine " +
      "ambiguity — for routine ambiguity, make a reasonable assumption yourself and note it in context.md.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "The specific blocker or question for a human" } },
      required: ["question"],
      additionalProperties: false,
    },
  },
  schema: requestHumanInputSchema,
  execute: async ({ question }) =>
    `Logged for human review: "${question}". No synchronous answer is available — proceed using your best ` +
    "judgment, document the assumption you're making, and continue with the rest of the goal.",
};
