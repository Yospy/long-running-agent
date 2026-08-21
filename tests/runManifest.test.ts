import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summarizeRunUsage, updateRunManifest, writeRunManifest, type RunManifest } from "../src/context/runManifest.js";
import type { CheckpointEntry } from "../src/context/checkpointLog.js";

function baseManifest(): RunManifest {
  return {
    runId: "run-test-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    mode: "autonomous",
    model: "claude-opus-5",
    effort: "medium",
    compactionBudgetTokens: 12_000,
    maxIterations: 45,
    subagentMaxIterations: 15,
    maxConcurrentSubagents: 4,
    rocketVersion: "0.1.0",
    nodeVersion: process.version,
  };
}

describe("run manifest", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "rocket-manifest-"));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("writes a manifest that reads back identical to what was written", async () => {
    const manifest = baseManifest();
    await writeRunManifest(runDir, manifest);

    const raw = await readFile(join(runDir, "run.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(manifest);
  });

  it("merges a patch on top of the existing manifest instead of replacing it", async () => {
    await writeRunManifest(runDir, baseManifest());
    await updateRunManifest(runDir, { endedAt: "2026-01-01T00:05:00.000Z", durationMs: 300_000, finalStatus: "done" });

    const raw = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
    // Original config fields survive the patch...
    expect(raw.model).toBe("claude-opus-5");
    expect(raw.compactionBudgetTokens).toBe(12_000);
    // ...alongside the newly patched terminal fields.
    expect(raw.finalStatus).toBe("done");
    expect(raw.durationMs).toBe(300_000);
  });

  it("a second patch layers on top of the first rather than discarding it", async () => {
    await writeRunManifest(runDir, baseManifest());
    await updateRunManifest(runDir, { iterationsUsed: 12 });
    await updateRunManifest(runDir, { finalStatus: "interactive_session_ended", totalTurns: 3 });

    const raw = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
    expect(raw.iterationsUsed).toBe(12); // from the first patch
    expect(raw.finalStatus).toBe("interactive_session_ended"); // from the second
    expect(raw.totalTurns).toBe(3);
  });

  it("tolerates a patch with no prior manifest on disk", async () => {
    await updateRunManifest(runDir, { finalStatus: "error" });
    const raw = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
    expect(raw.finalStatus).toBe("error");
  });
});

function usageEntry(jobId: string, seq: number, overrides: Partial<Record<string, number>> = {}): CheckpointEntry {
  return {
    seq,
    jobId,
    type: "usage",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: {
      phase: "planning",
      inputTokens: overrides.inputTokens ?? 100,
      outputTokens: overrides.outputTokens ?? 50,
      cacheReadInputTokens: overrides.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: overrides.cacheCreationInputTokens ?? 0,
      totalPromptTokens: 100,
      budgetTokens: 1000,
    },
  };
}

function compactionEntry(jobId: string, seq: number): CheckpointEntry {
  return { seq, jobId, type: "compaction", timestamp: "2026-01-01T00:00:00.000Z", payload: { mergedTurns: 2, archivePointer: "x:y" } };
}

describe("summarizeRunUsage", () => {
  it("sums usage fields and counts compactions for the given jobId only", () => {
    const entries: CheckpointEntry[] = [
      usageEntry("main", 0, { inputTokens: 100, outputTokens: 20 }),
      compactionEntry("main", 1),
      usageEntry("main", 2, { inputTokens: 50, outputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 3 }),
      // A subagent's own entries must not leak into the main job's totals.
      usageEntry("subagent-a", 3, { inputTokens: 999, outputTokens: 999 }),
      compactionEntry("subagent-a", 4),
    ];

    const summary = summarizeRunUsage(entries, "main");
    expect(summary).toEqual({
      compactionCount: 1,
      usageCallCount: 2,
      totalInputTokens: 150,
      totalOutputTokens: 30,
      totalCacheReadTokens: 5,
      totalCacheCreationTokens: 3,
    });
  });

  it("returns all zeros for a jobId with no matching entries", () => {
    const summary = summarizeRunUsage([usageEntry("main", 0)], "nonexistent");
    expect(summary).toEqual({
      compactionCount: 0,
      usageCallCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });
  });
});
