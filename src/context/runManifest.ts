import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckpointEntry } from "./checkpointLog.js";

export type RunMode = "autonomous" | "interactive";

export type RunFinalStatus =
  | "done"
  | "error"
  | "budget_exceeded"
  | "interactive_session_ended";

export interface RunManifest {
  runId: string;
  createdAt: string;
  mode: RunMode;
  model: string;
  effort: string;
  compactionBudgetTokens: number;
  maxIterations?: number;
  maxIterationsPerTurn?: number;
  subagentMaxIterations: number;
  maxConcurrentSubagents: number;
  rocketVersion: string;
  nodeVersion: string;
  endedAt?: string;
  durationMs?: number;
  finalStatus?: RunFinalStatus;
  iterationsUsed?: number;
  compactionCount?: number;
  totalTurns?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
}

function manifestPath(runDir: string): string {
  return join(runDir, "run.json");
}

/** Initial write, at session setup — before anything the run itself does. */
export async function writeRunManifest(runDir: string, manifest: RunManifest): Promise<void> {
  await writeFile(manifestPath(runDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * Read-merge-write patch, for the terminal fields (endedAt/status/counts) that are only known
 * once the run reaches an end state. Never called concurrently with itself for the same runDir in
 * this codebase (one run = one top-level driver), so a bare read-then-write is safe — no lock
 * needed.
 */
export async function updateRunManifest(runDir: string, patch: Partial<RunManifest>): Promise<void> {
  const path = manifestPath(runDir);
  const existing = existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as RunManifest) : ({} as RunManifest);
  await writeFile(path, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, "utf8");
}

export interface RunUsageSummary {
  compactionCount: number;
  usageCallCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

/**
 * Derives compaction count and token totals from the append-only checkpoint log itself, rather
 * than threading a second accumulator through the loop — one source of truth, the same way
 * CheckpointLog.open() recomputes its own seq counter from the log instead of trusting external
 * state.
 */
export function summarizeRunUsage(entries: CheckpointEntry[], jobId: string): RunUsageSummary {
  const summary: RunUsageSummary = {
    compactionCount: 0,
    usageCallCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
  };
  for (const entry of entries) {
    if (entry.jobId !== jobId) continue;
    if (entry.type === "compaction") {
      summary.compactionCount += 1;
    } else if (entry.type === "usage") {
      const payload = entry.payload as {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
      };
      summary.usageCallCount += 1;
      summary.totalInputTokens += payload.inputTokens;
      summary.totalOutputTokens += payload.outputTokens;
      summary.totalCacheReadTokens += payload.cacheReadInputTokens;
      summary.totalCacheCreationTokens += payload.cacheCreationInputTokens;
    }
  }
  return summary;
}
