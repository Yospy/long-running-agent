import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInteractiveSession } from "../src/loop/session.js";
import { CheckpointLog } from "../src/context/checkpointLog.js";
import { Scratchpad } from "../src/context/scratchpad.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { GenerateResult, ModelClient } from "../src/model/client.js";

const USAGE = { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function textResult(json: unknown): GenerateResult {
  return { content: [{ type: "text", text: JSON.stringify(json) }], toolCalls: [], usage: USAGE, stopReason: "end_turn" };
}

function toolUseResult(name: string, id: string): GenerateResult {
  const input = { path: id };
  return { content: [{ type: "tool_use", id, name, input }], toolCalls: [{ id, name, input }], usage: USAGE, stopReason: "tool_use" };
}

function answerResult(text: string): GenerateResult {
  return { content: [{ type: "text", text }], toolCalls: [], usage: USAGE, stopReason: "end_turn" };
}

const INTAKE_RESPONSE = textResult({ restatedGoal: "Do X", assumptions: [], successCriteria: ["Criterion A"] });

function makeScriptedClient(responses: GenerateResult[]): ModelClient {
  let index = 0;
  return {
    generate: async () => {
      if (index >= responses.length) throw new Error("scripted client ran out of responses");
      return responses[index++] as GenerateResult;
    },
  };
}

function makeInputQueue(inputs: (string | null)[]): () => Promise<string | null> {
  let index = 0;
  return async () => (index < inputs.length ? (inputs[index++] as string | null) : null);
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const schema = z.object({ path: z.string() });
  registry.register({
    definition: { name: "write_file", description: "write", inputSchema: { type: "object", properties: {}, required: [] } },
    schema,
    execute: async () => "ok",
  });
  registry.register({
    definition: { name: "read_file", description: "read", inputSchema: { type: "object", properties: {}, required: [] } },
    schema,
    execute: async () => "ok",
  });
  return registry;
}

describe("runInteractiveSession", () => {
  let runDir: string;
  let checkpointLog: CheckpointLog;
  let scratchpad: Scratchpad;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "rocket-session-"));
    checkpointLog = await CheckpointLog.open(join(runDir, "checkpoint.jsonl"));
    scratchpad = new Scratchpad(join(runDir, "scratch"));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("runs a single turn to a text response, then returns to waiting for input", async () => {
    const client = makeScriptedClient([INTAKE_RESPONSE, toolUseResult("write_file", "w1"), answerResult("Done, file written.")]);
    const responses: string[] = [];

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterationsPerTurn: 10,
      readInput: makeInputQueue(["Write a file", null]),
      onTurnResponse: (text) => responses.push(text),
    });

    expect(responses).toEqual(["Done, file written."]);
  });

  it("continues the same buffer across multiple turns without re-running intake", async () => {
    let generateCalls = 0;
    const client: ModelClient = {
      generate: async (params) => {
        generateCalls++;
        if (generateCalls === 1) return INTAKE_RESPONSE; // only ever called once, for the first message
        if (generateCalls === 2) return answerResult("First answer.");
        // Third call: confirm the first turn's exchange is still present in the prompt.
        const preamble = params.messages[0]?.content[0];
        const preambleText = preamble && preamble.type === "text" ? preamble.text : "";
        expect(preambleText).toContain("Do X");
        return answerResult("Second answer, building on the first.");
      },
    };
    const responses: string[] = [];

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterationsPerTurn: 10,
      readInput: makeInputQueue(["First message", "Second message", null]),
      onTurnResponse: (text) => responses.push(text),
    });

    expect(generateCalls).toBe(3); // 1 intake + 2 turns, not 2 intakes
    expect(responses).toEqual(["First answer.", "Second answer, building on the first."]);
  });

  it("ends the session immediately on 'exit' without starting a turn", async () => {
    const client = makeScriptedClient([INTAKE_RESPONSE]);
    let turnStarted = false;

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterationsPerTurn: 10,
      readInput: makeInputQueue(["exit"]),
      onTurnResponse: () => {
        turnStarted = true;
      },
    });

    expect(turnStarted).toBe(false);
  });

  it("compacts mid-turn, archives the pre-compaction buffer, and resets usage", async () => {
    const client = makeScriptedClient([
      INTAKE_RESPONSE,
      toolUseResult("write_file", "w1"),
      textResult({ ignored: "compaction merge output isn't JSON-parsed" }),
      answerResult("Done after compacting."),
    ]);
    let sawCompaction = false;

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 1, // trips shouldCompact as soon as any usage is known
      maxIterationsPerTurn: 10,
      readInput: makeInputQueue(["Write a file", null]),
      onTurnResponse: () => {},
      onCompaction: () => {
        sawCompaction = true;
      },
    });

    expect(sawCompaction).toBe(true);
    const entries = await checkpointLog.readAll();
    const compactionEntry = entries.find((entry) => entry.type === "compaction");
    expect(compactionEntry).toBeTruthy();

    // Same evidence guarantees as the autonomous loop (run.ts): an ordered, never-overwritten
    // snapshot alongside the overwrite-only context.md, and a "usage" record per generate call.
    const payload = compactionEntry?.payload as { contextSnapshot: string };
    const snapshotContent = await readFile(join(runDir, payload.contextSnapshot), "utf8");
    const liveContext = await readFile(join(runDir, "context.md"), "utf8");
    expect(snapshotContent).toBe(liveContext);

    const usagePhases = entries.filter((entry) => entry.type === "usage").map((entry) => (entry.payload as { phase: string }).phase);
    expect(usagePhases).toEqual(["planning", "compaction", "planning"]);
  });

  it("reports an intake failure via onTurnError and keeps waiting for input instead of throwing", async () => {
    const client: ModelClient = {
      generate: async () => {
        throw new Error("simulated API failure");
      },
    };
    const errors: string[] = [];

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterationsPerTurn: 10,
      readInput: makeInputQueue(["Hello", null]),
      onTurnResponse: () => {},
      onTurnError: (message) => errors.push(message),
    });

    expect(errors.length).toBeGreaterThan(0);
  });

  it("reports a mid-turn generate() failure (after intake already succeeded) and returns to the input loop", async () => {
    let generateCalls = 0;
    const client: ModelClient = {
      generate: async () => {
        generateCalls++;
        if (generateCalls === 1) return INTAKE_RESPONSE;
        throw new Error("simulated mid-turn API failure");
      },
    };
    const errors: string[] = [];
    const responses: string[] = [];

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterationsPerTurn: 10,
      readInput: makeInputQueue(["Hello", null]),
      onTurnResponse: (text) => responses.push(text),
      onTurnError: (message) => errors.push(message),
    });

    expect(generateCalls).toBe(2); // intake succeeded, the turn's own call is what failed
    expect(errors).toEqual(["This turn failed: simulated mid-turn API failure"]);
    expect(responses).toEqual([]);
  });

  it("trips strategic stall detection within a turn and reports it without crashing the session", async () => {
    const client = makeScriptedClient([
      INTAKE_RESPONSE,
      toolUseResult("read_file", "a"),
      toolUseResult("read_file", "b"),
      toolUseResult("read_file", "c"),
      toolUseResult("read_file", "d"),
      toolUseResult("read_file", "e"),
    ]);
    const errors: string[] = [];

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterationsPerTurn: 10,
      readInput: makeInputQueue(["Look around", null]),
      onTurnResponse: () => {},
      onTurnError: (message) => errors.push(message),
    });

    expect(errors.some((message) => message.includes("progress"))).toBe(true);
  });

  it("reports an initial 0/budget context reading before any turn starts", async () => {
    const client = makeScriptedClient([INTAKE_RESPONSE, answerResult("Done.")]);
    const readings: [number, number][] = [];

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 12_000,
      maxIterationsPerTurn: 10,
      readInput: makeInputQueue([null]), // session ends before any message — still expect the initial reading
      onTurnResponse: () => {},
      onContextUpdate: (used, budget) => readings.push([used, budget]),
    });

    expect(readings[0]).toEqual([0, 12_000]);
  });

  it("does not call onTurnResponse when onStreamEvent is wired (the text was already shown live)", async () => {
    const client = makeScriptedClient([INTAKE_RESPONSE, answerResult("Streamed live already.")]);
    const responses: string[] = [];

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterationsPerTurn: 10,
      readInput: makeInputQueue(["Hello", null]),
      onTurnResponse: (text) => responses.push(text),
      onStreamEvent: () => {},
    });

    expect(responses).toEqual([]);
  });

  it("reports the per-turn iteration cap via onTurnError instead of looping forever", async () => {
    // Every response keeps calling a tool, never yielding — the cap must still end the turn.
    const client = makeScriptedClient([
      INTAKE_RESPONSE,
      toolUseResult("write_file", "w1"),
      toolUseResult("write_file", "w2"),
      toolUseResult("write_file", "w3"),
    ]);
    const errors: string[] = [];

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterationsPerTurn: 3,
      readInput: makeInputQueue(["Keep working", null]),
      onTurnResponse: () => {},
      onTurnError: (message) => errors.push(message),
    });

    expect(errors).toEqual(["This turn hit its 3-iteration cap without finishing — try a narrower request."]);
  });

  it("reports a compaction failure via onTurnError and stops that turn instead of throwing", async () => {
    // compact() calls generate() itself — make that specific (third) call reject: 1st is
    // intake, 2nd is the turn's own generate (usage recorded, trips shouldCompact next
    // iteration), 3rd is compact()'s internal call.
    let calls = 0;
    const client: ModelClient = {
      generate: async () => {
        calls++;
        if (calls === 1) return INTAKE_RESPONSE;
        if (calls === 2) return toolUseResult("write_file", "w1");
        throw new Error("simulated compaction failure");
      },
    };
    const errors: string[] = [];

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 1, // trips shouldCompact as soon as any usage is known
      maxIterationsPerTurn: 10,
      readInput: makeInputQueue(["Write a file", null]),
      onTurnResponse: () => {},
      onTurnError: (message) => errors.push(message),
    });

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Compaction failed");
  });

  it("recovers from tactical stall (3 identical calls) within a turn instead of getting stuck", async () => {
    const client = makeScriptedClient([
      INTAKE_RESPONSE,
      toolUseResult("read_file", "a"),
      toolUseResult("read_file", "a"),
      toolUseResult("read_file", "a"), // 3rd identical call trips the tactical correction
      toolUseResult("write_file", "w1"), // model changes approach after the correction
      answerResult("Done after recovering."),
    ]);
    const responses: string[] = [];
    const errors: string[] = [];

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterationsPerTurn: 10,
      readInput: makeInputQueue(["Look something up", null]),
      onTurnResponse: (text) => responses.push(text),
      onTurnError: (message) => errors.push(message),
    });

    // Tactical stall is a soft correction, not a turn-ending failure — the turn should still
    // reach a normal response, not an error.
    expect(errors).toEqual([]);
    expect(responses).toEqual(["Done after recovering."]);
  });

  // Regression: the first message of every session hit intake before anything ever called
  // onGenerateStart — since intake doesn't stream, the terminal had nothing to show and just sat
  // blank until it resolved. Confirms it now fires for intake too, not just the turn loop's own
  // generate() calls (which is why this counts calls rather than just checking > 0).
  it("fires onGenerateStart before intake, in addition to before each turn-loop generate() call", async () => {
    const client = makeScriptedClient([INTAKE_RESPONSE, toolUseResult("write_file", "w1"), answerResult("Done.")]);
    let generateStarts = 0;

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterationsPerTurn: 10,
      readInput: makeInputQueue(["Write a file", null]),
      onTurnResponse: () => {},
      onGenerateStart: () => {
        generateStarts++;
      },
    });

    // 1 for intake + 2 for the turn loop's own two generate() calls (tool_use, then the answer).
    expect(generateStarts).toBe(3);
  });

  it("calls onToolCall with the structured name and input for each tool call", async () => {
    const client = makeScriptedClient([INTAKE_RESPONSE, toolUseResult("write_file", "w1"), answerResult("Done.")]);
    const calls: { name: string; input: unknown }[] = [];

    await runInteractiveSession({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterationsPerTurn: 10,
      readInput: makeInputQueue(["Write a file", null]),
      onTurnResponse: () => {},
      onToolCall: (name, input) => calls.push({ name, input }),
    });

    expect(calls).toEqual([{ name: "write_file", input: { path: "w1" } }]);
  });
});
