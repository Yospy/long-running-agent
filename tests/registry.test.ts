import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import { AgentError } from "../src/errors/taxonomy.js";

function registerEcho(registry: ToolRegistry): void {
  registry.register({
    definition: {
      name: "echo",
      description: "echo",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    schema: z.object({ text: z.string() }),
    execute: async ({ text }) => text.toUpperCase(),
  });
}

describe("ToolRegistry", () => {
  it("rejects an unknown tool name", async () => {
    const registry = new ToolRegistry();
    await expect(registry.dispatch("nope", {}, { runDir: ".", jobId: "j" })).rejects.toThrow(AgentError);
  });

  it("rejects input that fails schema validation", async () => {
    const registry = new ToolRegistry();
    registerEcho(registry);
    await expect(registry.dispatch("echo", { text: 5 }, { runDir: ".", jobId: "j" })).rejects.toThrow(AgentError);
  });

  it("dispatches valid input through to execute", async () => {
    const registry = new ToolRegistry();
    registerEcho(registry);
    expect(await registry.dispatch("echo", { text: "hi" }, { runDir: ".", jobId: "j" })).toBe("HI");
  });

  // Regression: dispatch_subagents was observed timing out at the generic 90s default even though
  // the subagents it dispatched were still correctly completing their work — that default is sized
  // for a single tool call, not for a tool that recursively runs whole nested agent loops. A
  // per-tool timeoutMs override lets a slow-but-legitimate tool avoid the generic ceiling.
  it("honors a per-tool timeoutMs override instead of the generic default", async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "slow",
        description: "slow",
        inputSchema: { type: "object", properties: {} },
      },
      schema: z.object({}),
      execute: async () => new Promise((resolve) => setTimeout(() => resolve("done"), 20)),
      timeoutMs: 5,
    });
    await expect(registry.dispatch("slow", {}, { runDir: ".", jobId: "j" })).rejects.toThrow(/exceeded 5ms/);
  });
});
