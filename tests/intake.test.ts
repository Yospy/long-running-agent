import { describe, expect, it } from "vitest";
import { runIntake } from "../src/loop/intake.js";
import { AgentError } from "../src/errors/taxonomy.js";
import type { GenerateParams, GenerateResult, ModelClient } from "../src/model/client.js";

function makeClient(result: GenerateResult): ModelClient {
  return {
    generate: async (_params: GenerateParams) => result,
  };
}

const USAGE = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

describe("runIntake", () => {
  it("parses a well-formed structured response into goal.md", async () => {
    const client = makeClient({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            restatedGoal: "Build X",
            assumptions: ["Y is available"],
            successCriteria: ["tests pass"],
          }),
        },
      ],
      toolCalls: [],
      usage: USAGE,
      stopReason: "end_turn",
    });

    const goalMd = await runIntake(client, "Build X");
    expect(goalMd).toContain("Build X");
    expect(goalMd).toContain("- Y is available");
    expect(goalMd).toContain("- [ ] tests pass");
  });

  // Regression: a live run observed subagent intake calls truncating mid-JSON at the old
  // 2048-token cap, which surfaced as an opaque "malformed JSON" error. This should now be
  // caught explicitly via stopReason, before the JSON.parse attempt even happens.
  it("reports truncation explicitly instead of falling through to a JSON-parse error", async () => {
    const client = makeClient({
      content: [{ type: "text", text: '{"restatedGoal": "Build X", "assumptions": ["a", "b"' }],
      toolCalls: [],
      usage: USAGE,
      stopReason: "max_tokens",
    });

    await expect(runIntake(client, "Build X")).rejects.toMatchObject({
      message: expect.stringContaining("truncated"),
    } satisfies Partial<AgentError>);
  });

  it("still raises a recoverable error for genuinely malformed (non-truncated) JSON", async () => {
    const client = makeClient({
      content: [{ type: "text", text: "not json at all" }],
      toolCalls: [],
      usage: USAGE,
      stopReason: "end_turn",
    });

    let caught: unknown;
    try {
      await runIntake(client, "Build X");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).recoverable).toBe(true);
  });

  // Intake is a narrow, bounded restate-the-goal call — extended thinking has no fixed budget and
  // competes with the JSON output for the same maxTokens ceiling (see INTAKE_MAX_TOKENS's comment).
  it("disables thinking, since it's a narrow call that doesn't need extended reasoning", async () => {
    let seenThinking: boolean | undefined;
    const client: ModelClient = {
      generate: async (params: GenerateParams) => {
        seenThinking = params.thinking;
        return {
          content: [{ type: "text", text: JSON.stringify({ restatedGoal: "X", assumptions: [], successCriteria: [] }) }],
          toolCalls: [],
          usage: USAGE,
          stopReason: "end_turn",
        };
      },
    };

    await runIntake(client, "Build X");
    expect(seenThinking).toBe(false);
  });
});
