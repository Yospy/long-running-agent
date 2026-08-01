import { describe, expect, it } from "vitest";
import { checkCompletion } from "../src/validation/completion.js";
import type { GenerateParams, GenerateResult, ModelClient, ModelMessage } from "../src/model/client.js";

const USAGE = { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

describe("checkCompletion", () => {
  it("includes the raw buffer in the prompt even when context.md is still empty", async () => {
    let seenPrompt = "";
    const client: ModelClient = {
      generate: async (params: GenerateParams): Promise<GenerateResult> => {
        const block = params.messages[0]?.content[0];
        seenPrompt = block && block.type === "text" ? block.text : "";
        return {
          content: [{ type: "text", text: JSON.stringify({ complete: false, unmetCriteria: [], reasoning: "n/a" }) }],
          toolCalls: [],
          usage: USAGE,
          stopReason: "end_turn",
        };
      },
    };

    const buffer: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "write_file", input: { path: "a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "1", content: "Wrote 5 bytes to a.txt", isError: false }] },
    ];

    // context.md is empty (no compaction has happened yet) — the buffer is the only evidence
    // of work done, and the checker must not be blind to it.
    await checkCompletion(client, "# Goal\n\n- [ ] write a.txt", "", buffer);

    expect(seenPrompt).toContain("Wrote 5 bytes to a.txt");
    expect(seenPrompt).not.toContain("Compacted working context");
  });

  it("omits the raw-transcript section entirely when the buffer is empty (nothing to show)", async () => {
    let seenPrompt = "";
    const client: ModelClient = {
      generate: async (params: GenerateParams): Promise<GenerateResult> => {
        const block = params.messages[0]?.content[0];
        seenPrompt = block && block.type === "text" ? block.text : "";
        return {
          content: [{ type: "text", text: JSON.stringify({ complete: true, unmetCriteria: [], reasoning: "n/a" }) }],
          toolCalls: [],
          usage: USAGE,
          stopReason: "end_turn",
        };
      },
    };

    await checkCompletion(client, "# Goal", "## Completed steps\n- did the thing", []);

    expect(seenPrompt).toContain("Compacted working context");
    expect(seenPrompt).not.toContain("Raw transcript");
  });

  // Regression: a live run observed a subagent's completion check truncating mid-JSON (a detailed
  // unmetCriteria/reasoning response exceeding the old 1024-token cap) and burning the subagent's
  // entire iteration budget on repeated retries before it could recover. This must be caught
  // explicitly via stopReason, not left to fall through to an opaque JSON.parse failure.
  it("reports truncation explicitly instead of falling through to a JSON-parse error", async () => {
    const client: ModelClient = {
      generate: async (): Promise<GenerateResult> => ({
        content: [{ type: "text", text: '{"complete": false, "unmetCriteria": ["a", "b"' }],
        toolCalls: [],
        usage: USAGE,
        stopReason: "max_tokens",
      }),
    };

    await expect(checkCompletion(client, "# Goal", "", [])).rejects.toMatchObject({
      message: expect.stringContaining("truncated"),
    });
  });

  // A completion check is a bounded true/false judgment against explicit criteria — extended
  // thinking has no fixed budget and competes with the JSON output for the same maxTokens ceiling,
  // which is exactly what caused the truncation this test file's other regression test covers.
  it("disables thinking, since it's a narrow call that doesn't need extended reasoning", async () => {
    let seenThinking: boolean | undefined;
    const client: ModelClient = {
      generate: async (params: GenerateParams) => {
        seenThinking = params.thinking;
        return {
          content: [{ type: "text", text: JSON.stringify({ complete: true, unmetCriteria: [], reasoning: "n/a" }) }],
          toolCalls: [],
          usage: USAGE,
          stopReason: "end_turn",
        };
      },
    };

    await checkCompletion(client, "# Goal", "", []);
    expect(seenThinking).toBe(false);
  });
});
