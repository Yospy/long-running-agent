import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/loop/run.js";
import { CheckpointLog } from "../src/context/checkpointLog.js";
import { Scratchpad, parsePointer } from "../src/context/scratchpad.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { GenerateResult, ModelClient } from "../src/model/client.js";
import { AgentError } from "../src/errors/taxonomy.js";

const USAGE = { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function textResult(json: unknown): GenerateResult {
  return { content: [{ type: "text", text: JSON.stringify(json) }], toolCalls: [], usage: USAGE, stopReason: "end_turn" };
}

function toolUseResult(name: string, id: string): GenerateResult {
  const input = { path: id };
  return {
    content: [{ type: "tool_use", id, name, input }],
    toolCalls: [{ id, name, input }],
    usage: USAGE,
    stopReason: "tool_use",
  };
}

const INTAKE_RESPONSE = textResult({ restatedGoal: "Do X", assumptions: [], successCriteria: ["Criterion A"] });
const NO_TOOL_RESPONSE: GenerateResult = { content: [{ type: "text", text: "done" }], toolCalls: [], usage: USAGE, stopReason: "end_turn" };
const COMPLETE_RESPONSE = textResult({ complete: true, unmetCriteria: [], reasoning: "All criteria met." });

function makeScriptedClient(responses: GenerateResult[]): ModelClient {
  let index = 0;
  return {
    generate: async () => {
      if (index >= responses.length) throw new Error("scripted client ran out of responses");
      return responses[index++] as GenerateResult;
    },
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const schema = z.object({ path: z.string() });
  registry.register({
    definition: { name: "read_file", description: "read", inputSchema: { type: "object", properties: {}, required: [] } },
    schema,
    execute: async () => "ok",
  });
  registry.register({
    definition: { name: "write_file", description: "write", inputSchema: { type: "object", properties: {}, required: [] } },
    schema,
    execute: async () => "ok",
  });
  return registry;
}

describe("runAgentLoop", () => {
  let runDir: string;
  let checkpointLog: CheckpointLog;
  let scratchpad: Scratchpad;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "rocket-run-"));
    checkpointLog = await CheckpointLog.open(join(runDir, "checkpoint.jsonl"));
    scratchpad = new Scratchpad(join(runDir, "scratch"));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("reaches done after a mutating tool call and a passing completion check", async () => {
    const client = makeScriptedClient([INTAKE_RESPONSE, toolUseResult("write_file", "w1"), NO_TOOL_RESPONSE, COMPLETE_RESPONSE]);

    const result = await runAgentLoop({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "job-happy",
      objective: "Do X",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterations: 10,
    });

    expect(result.summary).toBeTruthy();
  });

  it("trips strategic-stall when only read-only tool calls succeed, never advancing the goal", async () => {
    const client = makeScriptedClient([
      INTAKE_RESPONSE,
      toolUseResult("read_file", "a"),
      toolUseResult("read_file", "b"),
      toolUseResult("read_file", "c"),
      toolUseResult("read_file", "d"),
      toolUseResult("read_file", "e"),
    ]);

    await expect(
      runAgentLoop({
        client,
        tools: makeRegistry(),
        checkpointLog,
        scratchpad,
        runDir,
        jobId: "job-stalled",
        objective: "Do X",
        systemPrompt: "test",
        compactionBudgetTokens: 1_000_000,
        maxIterations: 10,
      }),
    ).rejects.toThrow(AgentError);

    const entries = await checkpointLog.readAll();
    expect(entries.some((entry) => entry.type === "error" && JSON.stringify(entry.payload).includes("strategic"))).toBe(true);
  });

  it("archives the exact pre-compaction buffer to the scratchpad before discarding it", async () => {
    // Budget of 1 trips shouldCompact as soon as the first call's usage is known, i.e. before
    // the second planning call — buffer at that point holds exactly [assistant, user tool_result].
    const client = makeScriptedClient([
      INTAKE_RESPONSE,
      toolUseResult("write_file", "w1"),
      textResult({ ignored: "compaction merge output isn't JSON-parsed, any text works" }),
      NO_TOOL_RESPONSE,
      COMPLETE_RESPONSE,
    ]);

    await runAgentLoop({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "job-compact",
      objective: "Do X",
      systemPrompt: "test",
      compactionBudgetTokens: 1,
      maxIterations: 10,
    });

    const entries = await checkpointLog.readAll();
    const compactionEntry = entries.find((entry) => entry.type === "compaction");
    expect(compactionEntry).toBeTruthy();

    const payload = compactionEntry?.payload as { archivePointer: string; mergedTurns: number };
    expect(payload.mergedTurns).toBe(2); // [assistant tool_use, user tool_result]

    const archived = JSON.parse(await scratchpad.read(parsePointer(payload.archivePointer))) as unknown[];
    expect(archived).toHaveLength(2);
  });

  // Regression: context.md is overwritten on every compaction, so only the *last* of a run's N
  // merged summaries ever survived as a file — every earlier boundary's carried-forward state was
  // otherwise only reconstructable by replaying checkpoint.jsonl by hand. The ordered snapshot
  // file is what makes each boundary's own merge independently inspectable.
  it("writes an ordered, never-overwritten compaction snapshot alongside the overwrite-only context.md", async () => {
    const client = makeScriptedClient([
      INTAKE_RESPONSE,
      toolUseResult("write_file", "w1"),
      textResult({ ignored: "compaction merge output isn't JSON-parsed, any text works" }),
      NO_TOOL_RESPONSE,
      COMPLETE_RESPONSE,
    ]);

    await runAgentLoop({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "job-snapshot",
      objective: "Do X",
      systemPrompt: "test",
      compactionBudgetTokens: 1,
      maxIterations: 10,
    });

    const entries = await checkpointLog.readAll();
    const compactionEntry = entries.find((entry) => entry.type === "compaction");
    const payload = compactionEntry?.payload as { contextSnapshot: string };
    expect(payload.contextSnapshot).toBe(join("compactions", "0000.md"));

    const snapshotContent = await readFile(join(runDir, payload.contextSnapshot), "utf8");
    const liveContext = await readFile(join(runDir, "context.md"), "utf8");
    expect(snapshotContent).toBe(liveContext);
  });

  // Regression: lastUsage drove shouldCompact live but was never persisted — nothing in
  // checkpoint.jsonl could prove the context window actually climbed and reset, only the final
  // in-memory state. A "usage" record per generate call (planning and the compaction merge alike)
  // makes that trajectory inspectable after the fact.
  it("checkpoints a usage record for each planning call and the compaction merge call", async () => {
    const client = makeScriptedClient([
      INTAKE_RESPONSE,
      toolUseResult("write_file", "w1"),
      textResult({ ignored: "compaction merge output isn't JSON-parsed, any text works" }),
      NO_TOOL_RESPONSE,
      COMPLETE_RESPONSE,
    ]);

    await runAgentLoop({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "job-usage",
      objective: "Do X",
      systemPrompt: "test",
      compactionBudgetTokens: 1,
      maxIterations: 10,
    });

    const entries = await checkpointLog.readAll();
    const usageEntries = entries.filter((entry) => entry.type === "usage");
    const phases = usageEntries.map((entry) => (entry.payload as { phase: string }).phase);
    // Two planning calls (before and after the compaction) plus the compaction merge itself.
    expect(phases).toEqual(["planning", "compaction", "planning"]);
    for (const entry of usageEntries) {
      const payload = entry.payload as { totalPromptTokens: number; budgetTokens: number };
      expect(payload.totalPromptTokens).toBe(10); // USAGE's inputTokens, no cache fields set
      expect(payload.budgetTokens).toBe(1);
    }
  });

  // The REPL's `/goal` path renders a run entirely through these callbacks — a missing or
  // mis-wired one means a dead screen during API round-trips or an invisible compaction, which
  // is the one event the demo exists to show. Budget of 1 forces a compaction after the first
  // planning call: onGenerateStart must cover the compaction merge too, and onContextUpdate
  // must reset to 0 right after it.
  it("fires onGenerateStart/onContextUpdate/onCompaction at the points a live UI needs them", async () => {
    const client = makeScriptedClient([
      INTAKE_RESPONSE,
      toolUseResult("write_file", "w1"),
      textResult({ ignored: "compaction merge output isn't JSON-parsed, any text works" }),
      NO_TOOL_RESPONSE,
      COMPLETE_RESPONSE,
    ]);
    let generateStarts = 0;
    const contextUpdates: [number, number][] = [];
    const compactions: { contextMd: string; mergedTurns: number; archivePointer: string }[] = [];

    await runAgentLoop({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "job-callbacks",
      objective: "Do X",
      systemPrompt: "test",
      compactionBudgetTokens: 1,
      maxIterations: 10,
      onGenerateStart: () => {
        generateStarts += 1;
      },
      onContextUpdate: (used, budget) => contextUpdates.push([used, budget]),
      onCompaction: (contextMd, mergedTurns, archivePointer) => compactions.push({ contextMd, mergedTurns, archivePointer }),
    });

    // Two planning calls + the compaction merge; the completion check doesn't count (it isn't
    // a planning generate).
    expect(generateStarts).toBe(3);
    expect(contextUpdates).toEqual([
      [10, 1], // first planning call's real usage (10 input tokens in USAGE)
      [0, 1], // reset right after the compaction
      [10, 1], // second planning call
    ]);
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.mergedTurns).toBe(2); // [assistant tool_use, user tool_result]
    expect(compactions[0]?.contextMd.trim().length).toBeGreaterThan(0);
    expect(compactions[0]?.archivePointer.length).toBeGreaterThan(0);
  });

  // Regression: subagents (no onStreamEvent) previously had zero visible reasoning in the
  // terminal — only bare "tool: X" lines. A job's turn-ending text content should now surface via
  // onEvent, so a live run's terminal output actually shows what a subagent is doing and why.
  it("surfaces a turn's text content via onEvent when there is no live onStreamEvent", async () => {
    const client = makeScriptedClient([
      INTAKE_RESPONSE,
      {
        content: [
          { type: "text", text: "Setting up the shared schema before delegating." },
          { type: "tool_use", id: "w1", name: "write_file", input: { path: "w1" } },
        ],
        toolCalls: [{ id: "w1", name: "write_file", input: { path: "w1" } }],
        usage: USAGE,
        stopReason: "tool_use",
      },
      NO_TOOL_RESPONSE,
      COMPLETE_RESPONSE,
    ]);
    const emitted: string[] = [];

    await runAgentLoop({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "endpoint-create",
      objective: "Do X",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterations: 10,
      onEvent: (line) => emitted.push(line),
    });

    expect(emitted).toContain("[endpoint-create] Setting up the shared schema before delegating.");
  });

  // Guards against double-display: the main job already shows its reasoning live via
  // onStreamEvent's raw token deltas, so the same text must not also be re-emitted whole via
  // onEvent once the turn completes.
  it("does not re-emit text via onEvent when onStreamEvent is already wired (avoids duplicate output)", async () => {
    const client = makeScriptedClient([
      INTAKE_RESPONSE,
      {
        content: [
          { type: "text", text: "Already streamed live, should not repeat." },
          { type: "tool_use", id: "w1", name: "write_file", input: { path: "w1" } },
        ],
        toolCalls: [{ id: "w1", name: "write_file", input: { path: "w1" } }],
        usage: USAGE,
        stopReason: "tool_use",
      },
      NO_TOOL_RESPONSE,
      COMPLETE_RESPONSE,
    ]);
    const emitted: string[] = [];

    await runAgentLoop({
      client,
      tools: makeRegistry(),
      checkpointLog,
      scratchpad,
      runDir,
      jobId: "main",
      objective: "Do X",
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterations: 10,
      onEvent: (line) => emitted.push(line),
      onStreamEvent: () => {},
    });

    expect(emitted.some((line) => line.includes("Already streamed live"))).toBe(false);
  });
});
