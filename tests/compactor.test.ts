import { describe, expect, it } from "vitest";
import { compact, shouldCompact } from "../src/context/compactor.js";
import type { GenerateResult, ModelClient } from "../src/model/client.js";

describe("shouldCompact", () => {
  const budget = 1000;

  it("stays under budget when the real prompt size is small", () => {
    const usage = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    expect(shouldCompact(usage, budget)).toBe(false);
  });

  it("triggers once input + cache tokens hit the budget", () => {
    const usage = { inputTokens: 400, outputTokens: 50, cacheReadInputTokens: 400, cacheCreationInputTokens: 200 };
    expect(shouldCompact(usage, budget)).toBe(true);
  });
});

describe("compact", () => {
  const USAGE = { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

  // Regression: unlike intake/completion, a truncated compaction has no JSON.parse step to fail
  // loudly on — before this fix, a truncated response would be silently accepted as the new
  // context.md, permanently losing whatever fell after the cut (worst case: the "Next planned
  // step" section, which renders last). Must fail loudly on stopReason "max_tokens" instead.
  it("refuses to accept a truncated compaction as the new context.md", async () => {
    const client: ModelClient = {
      generate: async (): Promise<GenerateResult> => ({
        content: [{ type: "text", text: "## Goal (restated)\n\nBuild X\n\n## Constraints" }],
        toolCalls: [],
        usage: USAGE,
        stopReason: "max_tokens",
      }),
    };

    await expect(compact(client, "# Goal", "", [])).rejects.toMatchObject({
      message: expect.stringContaining("truncated"),
    });
  });

  // Regression: compact() retries once at double the budget before giving up, rather than
  // aborting the job on the first truncation — the retry attempt must also keep thinking
  // disabled, not silently re-enable it.
  it("retries once at double the token budget and succeeds if the retry isn't truncated", async () => {
    let callCount = 0;
    const seenMaxTokens: (number | undefined)[] = [];
    const seenThinking: (boolean | undefined)[] = [];
    const client: ModelClient = {
      generate: async (params) => {
        callCount++;
        seenMaxTokens.push(params.maxTokens);
        seenThinking.push(params.thinking);
        if (callCount === 1) {
          return { content: [{ type: "text", text: "## Goal (restated)\n\ncut off here" }], toolCalls: [], usage: USAGE, stopReason: "max_tokens" };
        }
        return { content: [{ type: "text", text: "## Goal (restated)\n\nBuild X\n\n## Next planned step\n\nDone." }], toolCalls: [], usage: USAGE, stopReason: "end_turn" };
      },
    };

    const result = await compact(client, "# Goal", "", []);
    expect(callCount).toBe(2);
    expect(seenMaxTokens[1]).toBe((seenMaxTokens[0] ?? 0) * 2);
    expect(seenThinking).toEqual([false, false]);
    expect(result.contextMd).toContain("Next planned step");
    // The successful (retry) call's usage, not the truncated first attempt's — this is what
    // feeds the "usage" checkpoint record for a compaction merge.
    expect(result.usage).toEqual(USAGE);
  });

  it("returns the successful call's usage alongside the merged text", async () => {
    const usage = { inputTokens: 500, outputTokens: 120, cacheReadInputTokens: 30, cacheCreationInputTokens: 0 };
    const client: ModelClient = {
      generate: async () => ({
        content: [{ type: "text", text: "## Goal (restated)\n\nBuild X" }],
        toolCalls: [],
        usage,
        stopReason: "end_turn",
      }),
    };

    const result = await compact(client, "# Goal", "", []);
    expect(result.usage).toEqual(usage);
  });

  it("still fails loudly if the retry is truncated too", async () => {
    const client: ModelClient = {
      generate: async () => ({ content: [{ type: "text", text: "cut off" }], toolCalls: [], usage: USAGE, stopReason: "max_tokens" }),
    };

    await expect(compact(client, "# Goal", "", [])).rejects.toMatchObject({
      message: expect.stringContaining("retrying"),
    });
  });
});
