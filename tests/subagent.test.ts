import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatchSubagentsTool, type SubagentDispatchOptions } from "../src/orchestrator/subagent.js";
import { HeartbeatLedger } from "../src/orchestrator/ledger.js";
import { CheckpointLog } from "../src/context/checkpointLog.js";
import { Scratchpad } from "../src/context/scratchpad.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { GenerateResult, ModelClient, ModelMessage } from "../src/model/client.js";
import { AgentError } from "../src/errors/taxonomy.js";

const USAGE = { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function textResult(json: unknown): GenerateResult {
  return { content: [{ type: "text", text: JSON.stringify(json) }], toolCalls: [], usage: USAGE, stopReason: "end_turn" };
}

const NO_TOOL_RESPONSE: GenerateResult = {
  content: [{ type: "text", text: "done" }],
  toolCalls: [],
  usage: USAGE,
  stopReason: "end_turn",
};

function rawTextOf(messages: ModelMessage[]): string {
  const block = messages[0]?.content[0];
  return block && block.type === "text" ? block.text : "";
}

/** Stateless: judges each call purely by its own shape, so it's safe under concurrent subagent
 * execution (no shared index to race on). Intake raises for any objective containing FAIL_ME. */
function makeAutoCompleteClient(onIntake?: (rawObjective: string) => void): ModelClient {
  return {
    generate: async (params) => {
      const properties = (params.responseFormat as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      if ("restatedGoal" in properties) {
        const raw = rawTextOf(params.messages);
        onIntake?.(raw);
        if (raw.includes("FAIL_ME")) throw new Error("simulated intake failure");
        return textResult({ restatedGoal: "stub", assumptions: [], successCriteria: ["done"] });
      }
      if ("complete" in properties) return textResult({ complete: true, unmetCriteria: [], reasoning: "ok" });
      return NO_TOOL_RESPONSE;
    },
  };
}

describe("makeDispatchSubagentsTool", () => {
  let runsRoot: string;
  let checkpointLog: CheckpointLog;
  let scratchpad: Scratchpad;
  let ledger: HeartbeatLedger;

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), "rocket-dispatch-"));
    checkpointLog = await CheckpointLog.open(join(runsRoot, "checkpoint.jsonl"));
    scratchpad = new Scratchpad(join(runsRoot, "scratch"));
    ledger = new HeartbeatLedger();
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  function baseOptions(client: ModelClient, overrides: Partial<SubagentDispatchOptions> = {}): SubagentDispatchOptions {
    return {
      client,
      subagentTools: new ToolRegistry(),
      checkpointLog,
      scratchpad,
      ledger,
      runsRoot,
      systemPrompt: "test",
      compactionBudgetTokens: 1_000_000,
      maxIterationsPerSubagent: 10,
      maxConcurrentSubagents: 4,
      ...overrides,
    };
  }

  it("runs independent subtasks and reports both as done", async () => {
    const tool = makeDispatchSubagentsTool(baseOptions(makeAutoCompleteClient()));
    const output = await tool.execute(
      {
        subtasks: [
          { jobId: "a", objective: "do a" },
          { jobId: "b", objective: "do b" },
        ],
      },
      { runDir: runsRoot, jobId: "orchestrator" },
    );
    expect(output).toContain("## a (done)");
    expect(output).toContain("## b (done)");
  });

  it("waits for a dependency and folds its result into the dependent's objective before intake", async () => {
    const seenIntakeTexts: string[] = [];
    const tool = makeDispatchSubagentsTool(baseOptions(makeAutoCompleteClient((text) => seenIntakeTexts.push(text))));

    await tool.execute(
      {
        subtasks: [
          { jobId: "base", objective: "do base work" },
          { jobId: "dependent", objective: "do dependent work", dependsOn: ["base"] },
        ],
      },
      { runDir: runsRoot, jobId: "orchestrator" },
    );

    expect(seenIntakeTexts).toHaveLength(2);
    const dependentIntake = seenIntakeTexts.find((text) => text.includes("do dependent work"));
    expect(dependentIntake).toContain('### Result from prerequisite "base"');
  });

  it("folds every prerequisite's result into a diamond dependent (A <- B,C <- D)", async () => {
    const seenIntakeTexts: string[] = [];
    const tool = makeDispatchSubagentsTool(baseOptions(makeAutoCompleteClient((text) => seenIntakeTexts.push(text))));

    const output = await tool.execute(
      {
        subtasks: [
          { jobId: "b", objective: "do b work" },
          { jobId: "c", objective: "do c work" },
          { jobId: "d", objective: "do d work", dependsOn: ["b", "c"] },
        ],
      },
      { runDir: runsRoot, jobId: "orchestrator" },
    );

    expect(output).toContain("## b (done)");
    expect(output).toContain("## c (done)");
    expect(output).toContain("## d (done)");

    const dIntake = seenIntakeTexts.find((text) => text.includes("do d work"));
    expect(dIntake).toContain('### Result from prerequisite "b"');
    expect(dIntake).toContain('### Result from prerequisite "c"');
  });

  it("rejects duplicate jobIds in the same call", async () => {
    const tool = makeDispatchSubagentsTool(baseOptions(makeAutoCompleteClient()));
    await expect(
      tool.execute(
        {
          subtasks: [
            { jobId: "a", objective: "do a" },
            { jobId: "a", objective: "do a again" },
          ],
        },
        { runDir: runsRoot, jobId: "orchestrator" },
      ),
    ).rejects.toThrow(AgentError);
  });

  it("detects a 3-node dependency cycle", async () => {
    const tool = makeDispatchSubagentsTool(baseOptions(makeAutoCompleteClient()));
    await expect(
      tool.execute(
        {
          subtasks: [
            { jobId: "a", objective: "do a", dependsOn: ["c"] },
            { jobId: "b", objective: "do b", dependsOn: ["a"] },
            { jobId: "c", objective: "do c", dependsOn: ["b"] },
          ],
        },
        { runDir: runsRoot, jobId: "orchestrator" },
      ),
    ).rejects.toThrow(AgentError);
  });

  it("rejects a dependsOn reference to a jobId outside this call", async () => {
    const tool = makeDispatchSubagentsTool(baseOptions(makeAutoCompleteClient()));
    await expect(
      tool.execute({ subtasks: [{ jobId: "a", objective: "do a", dependsOn: ["ghost"] }] }, { runDir: runsRoot, jobId: "orchestrator" }),
    ).rejects.toThrow(AgentError);
  });

  it("detects a dependency cycle", async () => {
    const tool = makeDispatchSubagentsTool(baseOptions(makeAutoCompleteClient()));
    await expect(
      tool.execute(
        {
          subtasks: [
            { jobId: "a", objective: "do a", dependsOn: ["b"] },
            { jobId: "b", objective: "do b", dependsOn: ["a"] },
          ],
        },
        { runDir: runsRoot, jobId: "orchestrator" },
      ),
    ).rejects.toThrow(AgentError);
  });

  it("skips a subtask whose dependency failed instead of running it on incomplete context", async () => {
    const tool = makeDispatchSubagentsTool(baseOptions(makeAutoCompleteClient()));
    const output = await tool.execute(
      {
        subtasks: [
          { jobId: "base", objective: "FAIL_ME" },
          { jobId: "dependent", objective: "do dependent work", dependsOn: ["base"] },
        ],
      },
      { runDir: runsRoot, jobId: "orchestrator" },
    );
    expect(output).toContain("## base (error)");
    expect(output).toContain("## dependent (skipped)");
  });

  describe("bounded concurrency scheduler", () => {
    /** Every generate() call sleeps `delayMs`, tracking how many are in flight at once — a
     * direct proxy for "how many subagents are simultaneously mid-turn," since each subagent's
     * own 3 calls (intake/plan/complete) run back-to-back, not overlapped with each other. */
    function makeConcurrencyTrackingClient(delayMs: number): { client: ModelClient; peakConcurrent: () => number } {
      let active = 0;
      let peak = 0;
      const client: ModelClient = {
        generate: async (params) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          active--;
          const properties = (params.responseFormat as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
          if ("restatedGoal" in properties) return textResult({ restatedGoal: "stub", assumptions: [], successCriteria: ["done"] });
          if ("complete" in properties) return textResult({ complete: true, unmetCriteria: [], reasoning: "ok" });
          return NO_TOOL_RESPONSE;
        },
      };
      return { client, peakConcurrent: () => peak };
    }

    it("never runs more than maxConcurrentSubagents subagents at once", async () => {
      const { client, peakConcurrent } = makeConcurrencyTrackingClient(20);
      const tool = makeDispatchSubagentsTool(baseOptions(client, { maxConcurrentSubagents: 2 }));
      const subtasks = ["a", "b", "c", "d", "e", "f"].map((id) => ({ jobId: id, objective: `do ${id}` }));

      const output = await tool.execute({ subtasks }, { runDir: runsRoot, jobId: "orchestrator" });

      for (const id of ["a", "b", "c", "d", "e", "f"]) expect(output).toContain(`## ${id} (done)`);
      expect(peakConcurrent()).toBe(2); // proves both slots were actually used, not artificially serialized further
    });

    it("backfills a freed slot immediately, not gated on the rest of the original batch", async () => {
      /** Intake's raw prompt text is exactly the subtask's own objective (see loop/intake.ts),
       * so a marker in the objective is visible to key the per-subtask delay off of. */
      function delayFor(rawText: string): number {
        if (rawText.includes("SLOW")) return 150;
        return 5;
      }
      const events: { line: string; at: number }[] = [];
      const client: ModelClient = {
        generate: async (params) => {
          const properties = (params.responseFormat as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
          if ("restatedGoal" in properties) {
            await new Promise((resolve) => setTimeout(resolve, delayFor(rawTextOf(params.messages))));
            return textResult({ restatedGoal: "stub", assumptions: [], successCriteria: ["done"] });
          }
          if ("complete" in properties) return textResult({ complete: true, unmetCriteria: [], reasoning: "ok" });
          return NO_TOOL_RESPONSE;
        },
      };

      const tool = makeDispatchSubagentsTool(
        baseOptions(client, { maxConcurrentSubagents: 2, onEvent: (line) => events.push({ line, at: Date.now() }) }),
      );

      await tool.execute(
        {
          subtasks: [
            { jobId: "a-fast", objective: "do a-fast" },
            { jobId: "b-slow", objective: "do b-SLOW" },
            { jobId: "c-fast", objective: "do c-fast" },
          ],
        },
        { runDir: runsRoot, jobId: "orchestrator" },
      );

      const timeOf = (needle: string): number => events.find((e) => e.line.includes(needle))?.at ?? Number.NaN;
      const cStarted = timeOf("[c-fast] subagent started");
      const bDone = timeOf("[b-slow] subagent done");
      expect(cStarted).not.toBeNaN();
      expect(bDone).not.toBeNaN();
      // c-fast can only start once a-fast frees its slot (cap is 2, a+b take both immediately) —
      // if the scheduler were wave-locked instead of backfilling, c-fast would only start after
      // b-slow *also* finished, i.e. cStarted would be >= bDone, not comfortably before it.
      expect(cStarted).toBeLessThan(bDone);
    });

    it("emits started/queued/done onEvent lines for the right jobIds", async () => {
      const events: string[] = [];
      const tool = makeDispatchSubagentsTool(
        baseOptions(makeAutoCompleteClient(), { maxConcurrentSubagents: 1, onEvent: (line) => events.push(line) }),
      );

      await tool.execute(
        { subtasks: [{ jobId: "a", objective: "do a" }, { jobId: "b", objective: "do b" }] },
        { runDir: runsRoot, jobId: "orchestrator" },
      );

      expect(events).toContain("[a] subagent started");
      expect(events).toContain("[b] subagent queued (waiting for a free slot)"); // cap=1, b must wait
      expect(events).toContain("[a] subagent done");
      expect(events).toContain("[b] subagent started");
      expect(events).toContain("[b] subagent done");
    });

    it("leaves no heartbeat timers running after every subtask settles, including a failure path", async () => {
      vi.useFakeTimers();
      try {
        const tool = makeDispatchSubagentsTool(baseOptions(makeAutoCompleteClient(), { maxConcurrentSubagents: 4 }));
        await tool.execute(
          {
            subtasks: [
              { jobId: "ok", objective: "do ok" },
              { jobId: "bad", objective: "FAIL_ME" },
            ],
          },
          { runDir: runsRoot, jobId: "orchestrator" },
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
