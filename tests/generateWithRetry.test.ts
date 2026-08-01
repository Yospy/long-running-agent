import { describe, expect, it } from "vitest";
import { generateWithRetry, type GenerateResult, type ModelClient } from "../src/model/client.js";
import { AgentError } from "../src/errors/taxonomy.js";

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const OK: GenerateResult = { content: [{ type: "text", text: "ok" }], toolCalls: [], usage: USAGE, stopReason: "end_turn" };
const PARAMS = { systemPrompt: "test", tools: [], messages: [] };

function recoverableFailure(): AgentError {
  return new AgentError({ kind: "model", message: "overloaded", recoverable: true });
}

function fatalFailure(): AgentError {
  return new AgentError({ kind: "model", message: "bad request", recoverable: false });
}

describe("generateWithRetry", () => {
  it("retries a recoverable failure and returns the eventual success", async () => {
    let calls = 0;
    const client: ModelClient = {
      generate: async () => {
        calls += 1;
        if (calls < 3) throw recoverableFailure();
        return OK;
      },
    };

    const result = await generateWithRetry(client, PARAMS, { retryDelayMs: 0, maxAttempts: 5 });
    expect(result).toBe(OK);
    expect(calls).toBe(3);
  });

  it("does not retry a non-recoverable failure", async () => {
    let calls = 0;
    const client: ModelClient = {
      generate: async () => {
        calls += 1;
        throw fatalFailure();
      },
    };

    await expect(generateWithRetry(client, PARAMS, { retryDelayMs: 0 })).rejects.toThrow(AgentError);
    expect(calls).toBe(1);
  });

  it("gives up after exhausting attempts on a persistently recoverable failure", async () => {
    let calls = 0;
    const client: ModelClient = {
      generate: async () => {
        calls += 1;
        throw recoverableFailure();
      },
    };

    await expect(generateWithRetry(client, PARAMS, { retryDelayMs: 0, maxAttempts: 3 })).rejects.toThrow(AgentError);
    expect(calls).toBe(3);
  });
});
