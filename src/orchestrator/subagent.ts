import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Tool, ToolRegistry } from "../tools/registry.js";
import type { ModelClient } from "../model/client.js";
import type { CheckpointLog } from "../context/checkpointLog.js";
import { runAgentLoop } from "../loop/run.js";
import type { Scratchpad } from "../context/scratchpad.js";
import { HeartbeatLedger } from "./ledger.js";
import { AgentError } from "../errors/taxonomy.js";

export interface SubagentDispatchOptions {
  client: ModelClient;
  subagentTools: ToolRegistry;
  checkpointLog: CheckpointLog;
  scratchpad: Scratchpad;
  ledger: HeartbeatLedger;
  runsRoot: string;
  systemPrompt: string;
  compactionBudgetTokens: number;
  maxIterationsPerSubagent: number;
  /** Hard cap on subagents actually running at once. Additional ready subtasks queue and start
   * the instant a slot frees, rather than waiting for the rest of their dependency wave. */
  maxConcurrentSubagents: number;
  onEvent?: (line: string) => void;
}

// How often a still-running subagent gets a "still running" ping via onEvent. Purely
// observability — the layered timeouts elsewhere (registry's 90s/tool, this tool's own 30-minute
// safety net, each subagent's maxIterations cap) remain the only real enforcement.
const HEARTBEAT_TICK_INTERVAL_MS = 15_000;

const dispatchSchema = z.object({
  subtasks: z
    .array(
      z.object({
        jobId: z.string(),
        objective: z.string(),
        dependsOn: z.array(z.string()).optional(),
      }),
    )
    .min(1),
});

type Subtask = z.infer<typeof dispatchSchema>["subtasks"][number];

type SubtaskOutcome =
  | { status: "fulfilled"; value: string }
  | { status: "rejected"; reason: unknown }
  | { status: "skipped"; reason: string };

const MAX_SUMMARY_CHARS = 8_000; // ~2K tokens, per the sprint doc's capped-report-back budget

// The registry's generic DEFAULT_TIMEOUT_MS (90s) is sized for a single tool call, not for this
// tool: dispatch_subagents recursively runs up to several full nested agent loops in parallel,
// each with its own iteration cap and its own generateWithRetry backoff. Observed live: a batch of
// 4 subagents at maxIterationsPerSubagent=15 exceeded 90s even though every subagent completed its
// work correctly — the registry's withTimeout doesn't cancel the underlying promise, so the main
// loop moved on believing the dispatch had failed while the subagents kept writing files
// underneath it, silently discarding the structured fulfilled/rejected/skipped outcome the rest of
// this file is built around. 30 minutes is a last-resort safety net against a genuinely hung
// promise, not an operational ceiling — actual duration is already bounded by
// maxIterationsPerSubagent and each generate call's own timeout/retry budget.
const DISPATCH_SUBAGENTS_TIMEOUT_MS = 30 * 60_000;

/**
 * Exposed to the top-level orchestrator only (never wired into a subagent's own registry) —
 * that's what enforces one level of delegation. Reuses runAgentLoop recursively, one call per
 * subtask, and reports back a capped summary per subtask rather than the full transcript.
 *
 * Subtasks with no dependsOn among each other are eligible to run together, bounded by
 * `maxConcurrentSubagents` — up to that many run at once, the rest queue and start the instant a
 * slot frees (not held back for the rest of their wave). A subtask naming others in dependsOn
 * waits for them and gets their summaries folded into its own objective — one call can express
 * parallel, sequential, or mixed dispatch, all under the same concurrency cap.
 */
export function makeDispatchSubagentsTool(options: SubagentDispatchOptions): Tool<z.infer<typeof dispatchSchema>> {
  return {
    definition: {
      name: "dispatch_subagents",
      description:
        `Delegate independent subtasks to subagents. Up to ${options.maxConcurrentSubagents} run concurrently; ` +
        "additional ready subtasks queue and start as soon as a slot frees. A subtask that names others in " +
        "dependsOn waits for them first and receives their results as extra context — use this for genuinely " +
        "sequential work, not as a default. Returns a capped summary per subtask, not the full transcript. " +
        "Narrow, explicit objectives only — vague or overlapping ones cause duplicate work.",
      inputSchema: {
        type: "object",
        properties: {
          subtasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                jobId: { type: "string", description: "Short unique id for this subtask, e.g. 'endpoint-create'" },
                objective: { type: "string", description: "The narrow, explicit objective for this subagent" },
                dependsOn: {
                  type: "array",
                  items: { type: "string" },
                  description: "jobIds (from this same call) that must complete first; their results are folded into this objective",
                },
              },
              required: ["jobId", "objective"],
              additionalProperties: false,
            },
          },
        },
        required: ["subtasks"],
        additionalProperties: false,
      },
    },
    schema: dispatchSchema,
    execute: async ({ subtasks }) => runDispatchPlan(subtasks, options),
    timeoutMs: DISPATCH_SUBAGENTS_TIMEOUT_MS,
  };
}

async function runDispatchPlan(subtasks: Subtask[], options: SubagentDispatchOptions): Promise<string> {
  const byId = new Map(subtasks.map((subtask) => [subtask.jobId, subtask]));
  if (byId.size !== subtasks.length) {
    throw new AgentError({
      kind: "validation",
      message: "dispatch_subagents: duplicate jobId in the same call — every subtask needs a unique id",
      recoverable: true,
    });
  }
  for (const subtask of subtasks) {
    for (const dep of subtask.dependsOn ?? []) {
      if (!byId.has(dep)) {
        throw new AgentError({
          kind: "validation",
          message: `dispatch_subagents: subtask "${subtask.jobId}" has dependsOn "${dep}", which isn't in this same call`,
          recoverable: true,
        });
      }
    }
  }

  const results = new Map<string, SubtaskOutcome>();
  const remaining = new Set(subtasks.map((subtask) => subtask.jobId));
  const isReady = (id: string): boolean => (byId.get(id)!.dependsOn ?? []).every((dep) => results.has(dep));

  // Bounded worker pool: at most maxConcurrentSubagents subtasks in `inFlight` at once. Unlike a
  // wave-based `Promise.all` per readiness-tier, a freed slot is backfilled the instant the next
  // `Promise.race` settles — a subtask that becomes ready mid-batch doesn't wait for its whole
  // original tier to finish, only for an actual slot.
  const inFlight = new Map<string, Promise<{ id: string; outcome: SubtaskOutcome }>>();
  const announcedQueued = new Set<string>();

  function launch(id: string): void {
    const subtask = byId.get(id)!;
    const deps = subtask.dependsOn ?? [];
    const failedDep = deps.find((dep) => results.get(dep)?.status !== "fulfilled");

    if (failedDep) {
      const outcome: SubtaskOutcome = { status: "skipped", reason: `prerequisite "${failedDep}" did not complete successfully` };
      options.onEvent?.(`[${id}] subagent skipped (prerequisite "${failedDep}" did not complete)`);
      inFlight.set(id, Promise.resolve({ id, outcome }));
      return;
    }

    const objective = deps.length === 0 ? subtask.objective : withDependencyContext(subtask.objective, deps, results);
    const startedAt = Date.now();
    options.onEvent?.(`[${id}] subagent started`);
    const heartbeatTimer = setInterval(() => {
      options.onEvent?.(`[${id}] subagent still running (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    }, HEARTBEAT_TICK_INTERVAL_MS);

    const settled = runSubagentWithRetry(id, objective, options).then(
      (value): SubtaskOutcome => ({ status: "fulfilled", value }),
      (reason): SubtaskOutcome => ({ status: "rejected", reason }),
    );

    inFlight.set(
      id,
      settled.then((outcome) => {
        clearInterval(heartbeatTimer);
        options.onEvent?.(`[${id}] subagent ${outcome.status === "fulfilled" ? "done" : "failed"}`);
        return { id, outcome };
      }),
    );
  }

  while (remaining.size > 0) {
    const readyToStart = [...remaining].filter((id) => !inFlight.has(id) && isReady(id));

    for (const id of readyToStart) {
      if (inFlight.size >= options.maxConcurrentSubagents) break;
      launch(id);
    }

    for (const id of readyToStart) {
      if (!inFlight.has(id) && !announcedQueued.has(id)) {
        options.onEvent?.(`[${id}] subagent queued (waiting for a free slot)`);
        announcedQueued.add(id);
      }
    }

    if (inFlight.size === 0) {
      throw new AgentError({
        kind: "validation",
        message: `dispatch_subagents: dependency cycle among: ${[...remaining].join(", ")}`,
        recoverable: true,
      });
    }

    const { id, outcome } = await Promise.race(inFlight.values());
    results.set(id, outcome);
    remaining.delete(id);
    inFlight.delete(id);
  }

  return subtasks.map((subtask) => renderOutcome(subtask.jobId, results.get(subtask.jobId)!)).join("\n\n");
}

function withDependencyContext(objective: string, deps: string[], results: Map<string, SubtaskOutcome>): string {
  const context = deps
    .map((dep) => {
      const outcome = results.get(dep);
      const value = outcome && outcome.status === "fulfilled" ? outcome.value : "(unavailable)";
      return `### Result from prerequisite "${dep}"\n${value}`;
    })
    .join("\n\n");
  return `${objective}\n\n${context}`;
}

function renderOutcome(jobId: string, outcome: SubtaskOutcome): string {
  if (outcome.status === "fulfilled") return `## ${jobId} (done)\n${outcome.value}`;
  if (outcome.status === "skipped") return `## ${jobId} (skipped)\n${outcome.reason}`;
  const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
  return `## ${jobId} (error)\n${message}`;
}

async function runSubagentWithRetry(jobId: string, objective: string, options: SubagentDispatchOptions): Promise<string> {
  try {
    return await runSubagent(jobId, objective, options);
  } catch (firstError) {
    options.onEvent?.(`[${jobId}] first attempt failed, retrying once: ${(firstError as Error).message}`);
    try {
      return await runSubagent(`${jobId}-retry`, objective, options);
    } catch (secondError) {
      throw new AgentError({
        kind: "execution",
        message: `Subagent ${jobId} failed twice: ${(secondError as Error).message}`,
        recoverable: false,
        cause: secondError,
      });
    }
  }
}

async function runSubagent(jobId: string, objective: string, options: SubagentDispatchOptions): Promise<string> {
  const runDir = join(options.runsRoot, "jobs", jobId);
  await mkdir(runDir, { recursive: true });
  options.ledger.register(jobId);

  try {
    const { summary } = await runAgentLoop({
      client: options.client,
      tools: options.subagentTools,
      checkpointLog: options.checkpointLog,
      scratchpad: options.scratchpad,
      runDir,
      jobId,
      objective,
      systemPrompt: options.systemPrompt,
      compactionBudgetTokens: options.compactionBudgetTokens,
      maxIterations: options.maxIterationsPerSubagent,
      onIteration: () => options.ledger.heartbeat(jobId),
      onEvent: options.onEvent,
    });
    options.ledger.complete(jobId, "done");
    return capSummary(summary);
  } catch (error) {
    options.ledger.complete(jobId, "error");
    throw error;
  }
}

function capSummary(summary: string): string {
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}\n...[truncated]` : summary;
}
