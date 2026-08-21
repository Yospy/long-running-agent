import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import { Command } from "commander";

import { AnthropicClient, type EffortLevel, type StreamEvent } from "./model/client.js";
import { CheckpointLog } from "./context/checkpointLog.js";
import { Scratchpad } from "./context/scratchpad.js";
import { summarizeRunUsage, updateRunManifest, writeRunManifest, type RunFinalStatus } from "./context/runManifest.js";
import { ToolRegistry, type Tool } from "./tools/registry.js";
import { makeEditFileTool, makeListDirTool, makeReadFileTool, makeSearchTool, makeWriteFileTool } from "./tools/fileTools.js";
import { makeRunCommandTool } from "./tools/runCommand.js";
import { makeReadScratchpadTool } from "./tools/scratchpadTools.js";
import { requestHumanInputTool } from "./tools/humanInput.js";
import { makeToolCallPolicy } from "./tools/policy.js";
import { HeartbeatLedger } from "./orchestrator/ledger.js";
import { makeDispatchSubagentsTool } from "./orchestrator/subagent.js";
import { runAgentLoop, type RunLoopResult } from "./loop/run.js";
import { runInteractiveSession } from "./loop/session.js";
import { AGENT_SYSTEM_PROMPT, INTERACTIVE_SYSTEM_PROMPT } from "./loop/systemPrompt.js";
import { writeContext, writeGoal } from "./context/contextWindow.js";
import { AgentError } from "./errors/taxonomy.js";
import { THINKING_VERBS, formatElapsed, formatToolActivity, formatTurnSummary, parseGoalCommand, renderCompactionSummary, truncateDetail } from "./cli/render.js";
import { EphemeralRegion } from "./cli/ephemeralRegion.js";

// Resolved relative to this file's own location, not process.cwd() — deterministic regardless of
// where the CLI is invoked from.
const ROCKET_VERSION: string = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
})();

interface CliOptions {
  model?: string;
  effort?: string;
  maxIterations: string;
  maxIterationsPerTurn: string;
  subagentMaxIterations: string;
  maxConcurrentSubagents: string;
  compactionBudget: string;
  runId?: string;
}

// Same tool set for both registries — file ops, run_command, scratchpad, human-input. Built
// fresh per registry rather than shared, so there's no ambiguity about safe reuse.
function buildBaseTools(workspaceRoot: string, scratchpad: Scratchpad): Tool<any>[] {
  return [
    makeReadFileTool(workspaceRoot),
    makeWriteFileTool(workspaceRoot),
    makeEditFileTool(workspaceRoot),
    makeListDirTool(workspaceRoot),
    makeSearchTool(workspaceRoot),
    makeRunCommandTool(workspaceRoot),
    makeReadScratchpadTool(scratchpad),
    requestHumanInputTool,
  ];
}

// ---------------------------------------------------------------------------
// Rendering — solid black/white only. Plain (default-color) text for normal content, bold for
// emphasis/headers, red reserved for actual errors. No "dim" anywhere — it renders as a washed-
// out gray, not a solid color, against a plain black terminal background.
//
// The pure string-building parts of this (tool-call labels, the turn summary, the compaction
// summary) live in ./cli/render.js instead of here, specifically so they're unit-testable
// without this file's own top-level `await program.parseAsync()` firing on import.
// ---------------------------------------------------------------------------

function renderStreamEvent(event: StreamEvent): void {
  if (event.type === "text_delta") process.stdout.write(event.text);
  else if (event.type === "thinking_delta") process.stdout.write(event.text);
  else if (event.type === "tool_use_start") process.stdout.write(`\n⏺ ${event.name}\n`);
}

function renderEvent(line: string): void {
  console.log(`\n${line}`);
}

// ---------------------------------------------------------------------------
// Interactive mode's own renderer.
//
// Two things share the terminal: raw streamed tokens (no guaranteed trailing newline) and a
// single "live status" area — one line for the main job's current activity (an elapsed-time
// ticker while waiting on a generate() call, or the current tool call) plus one line per
// currently-active subagent underneath it. The status area is redrawn as a whole, in place,
// every time anything in it changes, rather than each tool call/status update printing a new
// permanent line — that's what stops the transcript from filling up with every tool ever called.
// It's cleared away before anything permanent (streamed text, a compaction summary, the turn
// summary, an error) prints, so nothing ephemeral ever lingers in scrollback.
//
// Both the raw-text writer and the status area share one "are we at the start of a line" flag —
// tracking that centrally is simpler and less bug-prone than guessing, case by case, which
// specific call sites need a defensive leading newline.
// ---------------------------------------------------------------------------

// Not one of styleText's built-in named colors (no "orange" in the ANSI 16-color set — see
// node:util's own error listing the supported names). A raw 256-color escape is the standard way
// to get a genuine orange; gated on isTTY the same way styleText itself no-ops on a non-terminal
// stream, so piped/redirected output doesn't get raw control bytes.
const supportsColor = process.stdout.isTTY === true;
const ORANGE_START = "\x1b[38;5;208m";
const ITALIC_START = "\x1b[3m";
const ANSI_RESET = "\x1b[0m";
function orange(text: string): string {
  return supportsColor ? `${ORANGE_START}${text}${ANSI_RESET}` : text;
}
function orangeItalic(text: string): string {
  return supportsColor ? `${ITALIC_START}${ORANGE_START}${text}${ANSI_RESET}` : text;
}

// Deliberately *unclosed* — an SGR (styling) escape code stays in effect until reset, including
// for whatever the terminal echoes next on its own. readline's own line-editing echo just writes
// the user's raw keystrokes; it doesn't know or care about styling. Starting inverse video here
// (no matching close code in the prompt string itself) means the terminal keeps rendering
// everything the user types in that same highlighted style, automatically — no need to erase and
// reprint the already-echoed line with cursor math after the fact, which would need to account
// for how many rows it wrapped across at the current terminal width, a much riskier calculation.
const INVERSE_START = "\x1b[7m";
function highlightedPrompt(text: string): string {
  return supportsColor ? `${INVERSE_START}${text}` : text;
}

// All interactive-mode mutable state lives here, grouped, rather than scattered next to whatever
// function first happens to use it — every piece is reset explicitly at the top of
// runInteractive() for each new session, and turn-scoped pieces are reset again per turn.
//
// Three genuinely separate channels share the terminal, all animating independently:
//   1. The spinner — one line, a rotating verb + live elapsed time + tokens, overwrites itself in
//      place (it's the same repeated "waiting" state, so collapsing it is correct).
//   2. Tool calls — every one, permanent, never overwritten (each is a distinct, meaningful
//      action worth keeping visible — collapsing *these* would hide real information, unlike the
//      spinner's repeated ticks).
//   3. Compaction — its own separate display (renderCompactionSummary), untouched by either.
let interactiveAtLineStart = true;
let statusRegion: EphemeralRegion; // backs the spinner only — tool calls never go through it
// The spinner's current verb ("Reasoning", "Planning", ...) — no detail, ever; tool calls are a
// separate, permanent channel now (see renderToolCall/printPermanentLines).
let currentVerb = "";
// Ephemeral per-subagent state only — intake/compacting/heartbeat pings, the subagent equivalent
// of the main job's spinner. Subagent *tool calls* are a separate, permanent channel (see
// renderSubagentEvent) and never end up in this map.
const subagentEphemeralStatus = new Map<string, string>();
let turnTicker: NodeJS.Timeout | undefined;
let turnStartedAt = 0;
let toolTally = new Map<string, number>();
let latestContextTokens = 0;
let compactionCount = 0;

function writeInteractiveRaw(text: string): void {
  if (text.length === 0) return;
  process.stdout.write(text);
  interactiveAtLineStart = text.endsWith("\n");
}

function printInteractiveLine(text = ""): void {
  if (!interactiveAtLineStart) process.stdout.write("\n");
  console.log(text);
  interactiveAtLineStart = true;
}

/** ["Reasoning… (12s · 3,240 tokens)", "  [subagent-a] intake", ...] — the spinner's own line
 * (if any verb is set) plus one ephemeral line per active subagent's non-tool-call status. */
function composeSpinnerLines(): string[] {
  const lines: string[] = [];
  if (currentVerb) {
    const elapsed = formatElapsed(Date.now() - turnStartedAt);
    lines.push(`* ${currentVerb} (${elapsed} · ${latestContextTokens.toLocaleString()} tokens)`);
  }
  for (const [jobId, status] of subagentEphemeralStatus) lines.push(`  [${jobId}] ${status}`);
  return lines;
}

function redrawStatus(): void {
  const lines = composeSpinnerLines();
  if (lines.length === 0) {
    // Only true when there was actually something visible to clear — a real transition, not a
    // redundant no-op call. Without this check: the per-turn ticker fires every second
    // regardless of what else is happening, including mid-stream while real text is being
    // written with no trailing newline yet. Every such tick hit this branch (nothing to show,
    // since the status area is correctly empty during streaming) and unconditionally claimed
    // "we're at line start" — clobbering the correct `false` that writeInteractiveRaw had just
    // set, so the *next* permanent print skipped its defensive newline and landed stuck onto the
    // end of the streamed sentence. Caught live: "...API endpoints.⏺ Running shell command…"
    // with no line break, not reproduced by any unit test (none of them run a ticker
    // concurrently with active streaming).
    if (statusRegion.isActive) {
      statusRegion.clear();
      interactiveAtLineStart = true;
    }
    return;
  }
  // Only relevant when the region isn't already active: if it is, update() overwrites exactly
  // where it last wrote and injecting a newline here would break that in-place overwrite. If
  // it's a fresh draw (e.g. right after unterminated streamed text — a model sentence with no
  // trailing newline, immediately followed by the spinner resuming), the region's first write
  // would otherwise land directly on the same row as whatever was there.
  if (!statusRegion.isActive && !interactiveAtLineStart) process.stdout.write("\n");
  statusRegion.update(lines, orange); // style applied post-truncation, inside update() itself
  interactiveAtLineStart = false;
}

function setSpinnerVerb(verb: string): void {
  currentVerb = verb;
  redrawStatus();
}

/** Prints permanent lines (not through the spinner's ephemeral region), clearing the spinner out
 * of the way first if it's currently showing, and letting it resume fresh underneath afterward.
 * The one shared choke point for anything permanent that needs to coexist with the spinner —
 * tool calls (orange), subagent commentary (plain), turn/compaction summaries (plain), errors
 * (red) all go through this rather than duplicating the clear-print-resume sequence. */
function printPermanentLines(lines: string[], style?: (line: string) => string): void {
  if (statusRegion.isActive) {
    statusRegion.clear();
    interactiveAtLineStart = true; // clear() genuinely left the cursor at column 0 of a fresh line
  }
  for (const line of lines) printInteractiveLine(style ? style(line) : line);
  redrawStatus();
}

/** Clears what the spinner is currently *displaying* — used right before permanent content
 * prints via paths that don't go through printPermanentLines (raw streamed text, which arrives
 * character-by-character rather than as discrete lines). Does not touch the per-turn ticker (see
 * startTurnTicker/stopTurnTicker): that spans the whole turn, not individual activities within
 * it, so elapsed time keeps advancing correctly across the gap even while nothing is shown. */
function clearSpinner(): void {
  currentVerb = "";
  subagentEphemeralStatus.clear();
  redrawStatus();
}

function stopTurnTicker(): void {
  if (turnTicker) {
    clearInterval(turnTicker);
    turnTicker = undefined;
  }
}

/** One ticker per turn (not per generate() call) — elapsed time and token count need to keep
 * advancing across the whole turn, including while a tool is executing, not just while waiting
 * on the model. */
function startTurnTicker(): void {
  stopTurnTicker();
  turnTicker = setInterval(redrawStatus, 1000);
}

let lastStreamContentType: "text" | "thinking" | undefined;

/** Interactive mode's own stream renderer: text/thinking deltas only. tool_use_start is
 * deliberately dropped here — onToolCall (wired separately) already announces each call once,
 * richly, once it's fully parsed; showing it again bare as soon as the block starts streaming
 * would just duplicate it. */
function renderInteractiveStreamEvent(event: StreamEvent): void {
  if (event.type === "text_delta" || event.type === "thinking_delta") {
    clearSpinner(); // real content is about to print — remove the spinner/subagent-status lines
    const contentType = event.type === "text_delta" ? "text" : "thinking";
    // Thinking and answer text otherwise run straight into each other with no separator when the
    // model transitions between them mid-turn (observed live: "...for the work.Empty workspace...")
    // — not data loss, just two distinct thoughts visually fused into one sentence.
    if (lastStreamContentType && lastStreamContentType !== contentType && !interactiveAtLineStart) {
      writeInteractiveRaw("\n");
    }
    lastStreamContentType = contentType;
    writeInteractiveRaw(event.text);
  }
}

/** Every tool call, permanent and orange — never overwritten, no matter how many happen in a
 * turn. Distinct from the spinner (which does overwrite): a tool call is a specific, meaningful
 * action, not a repeated "still waiting" tick, so collapsing it would hide real information. */
function renderToolCall(name: string, input: unknown): void {
  toolTally.set(name, (toolTally.get(name) ?? 0) + 1);
  const { summary, detail } = formatToolActivity(name, input);
  const lines = detail !== undefined ? [`⏺ ${summary}`, `  └ ${detail}`] : [`⏺ ${summary}`];
  printPermanentLines(lines, orange);
}

function pickThinkingVerb(): string {
  return THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)] ?? "Thinking";
}

/** Routes a job's status line: the main job's own lines are already covered by onToolCall/
 * onGenerateStart/onCompaction, so only other jobIds (subagents) get shown here. Three-way split,
 * mirroring the main job's own three channels:
 *
 * - Ephemeral status (intake/compacting/heartbeat/retry) — a subagent's equivalent of the
 *   spinner, safe to collapse into the shared ephemeral region.
 * - Tool calls ("tool: X") — permanent and orange, same channel and same reasoning as the main
 *   job's own tool calls: every one shown, never overwritten.
 * - Commentary — a subagent's substantive final report (loop/run.ts emits it line by line, since
 *   subagents have no live token streaming of their own). Permanent, plain (not orange — it's the
 *   model's own words, not an action taken). Routing this into the ephemeral region would
 *   silently truncate/destroy it.
 *
 * The patterns below are anchored to the exact shapes loop/run.ts and orchestrator/subagent.ts
 * actually emit (verified against every emit() call site in both files), not loose keywords —
 * narrowing, not eliminating, the residual risk that a subagent's own free-form report text could
 * coincidentally open with one of these same words and get misrouted. Fully closing that would
 * mean loop/run.ts marking lines explicitly rather than this file inferring their shape, which
 * touches already-validated code for a narrow edge case — left as a documented limitation.
 */
const SUBAGENT_EPHEMERAL_STATUS =
  /^(intake|compacting \(prompt hit|validating completion$|first attempt failed, retrying once:|subagent (started|queued|still running|done|failed|skipped))/;
const SUBAGENT_TOOL_CALL = /^tool: \w+/;

function renderSubagentEvent(line: string, mainJobId: string): void {
  const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
  if (!match) return;
  const [, jobId, rest] = match;
  if (jobId === mainJobId || !jobId) return;
  const text = rest ?? "";
  if (SUBAGENT_EPHEMERAL_STATUS.test(text)) {
    subagentEphemeralStatus.set(jobId, text);
    redrawStatus();
  } else if (SUBAGENT_TOOL_CALL.test(text)) {
    // Bare tool name only — subagent tool calls arrive as plain strings via loop/run.ts's emit(),
    // with no structured input/args available at this layer (unlike the main job's onToolCall).
    printPermanentLines([`[${jobId}] ⏺ ${text}`], orange);
  } else if (text.trim().length > 0) {
    // Only this job's ephemeral entry — not every subagent's, which would also wipe every
    // *other* concurrently-running subagent's tracked status, not just hide it on screen (caught
    // by an earlier review: their lines would then stay missing until each one's own next event,
    // rather than just being temporarily covered by this job's report).
    subagentEphemeralStatus.delete(jobId);
    printPermanentLines([`[${jobId}] ${text}`]);
  }
}

/** The main job's own onEvent lines during a `/goal` run — runAgentLoop emits status lines
 * ("intake", "compacting (…)", "validating completion") and bare "tool: X" lines, nothing else
 * (turn text streams live via onStreamEvent instead). Same split as subagent lines: status
 * collapses into the ephemeral spinner, tool calls are permanent and orange — tallied by hand
 * for the end-of-run summary, since runAgentLoop emits bare names, not structured calls.
 * Subagent lines from the same run never arrive here — they're routed at dispatch-tool
 * construction time (buildToolRegistries's onDispatchEvent). */
function renderMainJobEvent(line: string): void {
  const text = line.replace(/^\[main\]\s*/, "");
  const toolMatch = /^tool: (\w+)/.exec(text);
  if (toolMatch?.[1]) {
    toolTally.set(toolMatch[1], (toolTally.get(toolMatch[1]) ?? 0) + 1);
    printPermanentLines([`⏺ ${toolMatch[1]}`], orange);
  } else if (text.trim().length > 0) {
    setSpinnerVerb(`${text}…`);
  }
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

interface Session {
  client: AnthropicClient;
  checkpointLog: CheckpointLog;
  scratchpad: Scratchpad;
  ledger: HeartbeatLedger;
  runDir: string;
  workspaceRoot: string;
  compactionBudgetTokens: number;
  maxIterationsPerSubagent: number;
  maxConcurrentSubagents: number;
}

async function setUpSession(options: CliOptions, mode: "autonomous" | "interactive"): Promise<Session | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(styleText("red", "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add a real key."));
    process.exitCode = 1;
    return undefined;
  }

  const runId = options.runId ?? `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runDir = join(process.cwd(), "runs", runId);
  const workspaceRoot = join(runDir, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  console.log(styleText("bold", `Run: ${runId}`));
  console.log(`  runDir:    ${runDir}`);
  console.log(`  workspace: ${workspaceRoot}`);
  console.log();

  const client = new AnthropicClient({
    apiKey,
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort as EffortLevel } : {}),
  });

  // Recorded once, up front — the evidence question this answers ("what configuration produced
  // this run?") is otherwise only reconstructable from console scrollback, if that was even kept.
  const { model, effort } = client.getConfig();
  await writeRunManifest(runDir, {
    runId,
    createdAt: new Date().toISOString(),
    mode,
    model,
    effort,
    compactionBudgetTokens: Number(options.compactionBudget),
    maxIterations: Number(options.maxIterations),
    maxIterationsPerTurn: Number(options.maxIterationsPerTurn),
    subagentMaxIterations: Number(options.subagentMaxIterations),
    maxConcurrentSubagents: Number(options.maxConcurrentSubagents),
    rocketVersion: ROCKET_VERSION,
    nodeVersion: process.version,
  });

  return {
    client,
    checkpointLog: await CheckpointLog.open(join(runDir, "checkpoint.jsonl")),
    scratchpad: new Scratchpad(join(runDir, "scratchpad")),
    ledger: new HeartbeatLedger(),
    runDir,
    workspaceRoot,
    compactionBudgetTokens: Number(options.compactionBudget),
    maxIterationsPerSubagent: Number(options.subagentMaxIterations),
    maxConcurrentSubagents: Number(options.maxConcurrentSubagents),
  };
}

/** Two registries: dispatch_subagents is registered only on the orchestrator's, never a
 * subagent's own — that's what enforces one level of delegation. Both share the same policy
 * gate. Identical for both the autonomous and interactive modes — only the top-level driver, its
 * system prompt, and how dispatched-subagent events get rendered differ; delegated subagents
 * always run the autonomous loop regardless of which mode dispatched them.
 *
 * onDispatchEvent is a parameter, not hardcoded, specifically because subagent activity flows
 * through the onEvent bound here at tool-construction time — *not* through runInteractiveSession's
 * own onEvent parameter, which only ever sees the top-level job's own events. Wiring the
 * interactive mode's status-line routing into runInteractiveSession's onEvent instead of here was
 * a real bug caught live: subagent lines printed as a plain growing list regardless, exactly the
 * clutter this whole redesign exists to remove. */
function buildToolRegistries(
  session: Session,
  onDispatchEvent: (line: string) => void,
): { orchestratorTools: ToolRegistry; subagentTools: ToolRegistry } {
  const policy = makeToolCallPolicy(session.workspaceRoot);
  const subagentTools = new ToolRegistry(policy);
  for (const tool of buildBaseTools(session.workspaceRoot, session.scratchpad)) subagentTools.register(tool);

  const orchestratorTools = new ToolRegistry(policy);
  for (const tool of buildBaseTools(session.workspaceRoot, session.scratchpad)) orchestratorTools.register(tool);
  orchestratorTools.register(
    makeDispatchSubagentsTool({
      client: session.client,
      subagentTools,
      checkpointLog: session.checkpointLog,
      scratchpad: session.scratchpad,
      ledger: session.ledger,
      runsRoot: session.runDir,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      compactionBudgetTokens: session.compactionBudgetTokens,
      maxIterationsPerSubagent: session.maxIterationsPerSubagent,
      maxConcurrentSubagents: session.maxConcurrentSubagents,
      onEvent: onDispatchEvent,
    }),
  );

  return { orchestratorTools, subagentTools };
}

// ---------------------------------------------------------------------------
// Autonomous mode — reached two ways: a CLI goal argument (runAutonomous below, plain-console
// rendering, process exits at the end) or the REPL's `/goal` command (runGoalFromRepl, the
// interactive rendering layer, control returns to the prompt). Both wire the main job's
// runAgentLoop identically via runGoalWithSession — the only difference is rendering and what
// happens around the run.
// ---------------------------------------------------------------------------

interface GoalRunRenderers {
  onEvent: (line: string) => void;
  onStreamEvent: (event: StreamEvent) => void;
  onGenerateStart?: (() => void) | undefined;
  onContextUpdate?: ((usedTokens: number, budgetTokens: number) => void) | undefined;
  onCompaction?: ((contextMd: string, mergedTurns: number, archivePointer: string) => void) | undefined;
}

/** Closes out the run manifest + checkpoint log's own `run_end` record for the "main" job —
 * shared by both runGoalWithSession's outcomes and, separately, an interactive session's own
 * exit, so a run's evidence trail always ends with a definitive status instead of just trailing
 * off into whatever the last per-cause `error` record happened to be. */
async function finalizeMainRun(
  session: Session,
  startedAt: number,
  finalStatus: RunFinalStatus,
  extra: { iterationsUsed?: number; totalTurns?: number },
): Promise<void> {
  const entries = await session.checkpointLog.readAll();
  const usage = summarizeRunUsage(entries, "main");
  const durationMs = Date.now() - startedAt;
  await session.checkpointLog.append("main", "run_end", { status: finalStatus, durationMs, compactionCount: usage.compactionCount, ...extra });
  await updateRunManifest(session.runDir, {
    endedAt: new Date().toISOString(),
    durationMs,
    finalStatus,
    compactionCount: usage.compactionCount,
    totalInputTokens: usage.totalInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    totalCacheReadTokens: usage.totalCacheReadTokens,
    totalCacheCreationTokens: usage.totalCacheCreationTokens,
    ...extra,
  });
}

/** The one place a main-job autonomous run is wired — shared by the CLI-goal path and the
 * REPL's `/goal` command so the two can never drift apart on how the loop itself is driven. */
async function runGoalWithSession(
  session: Session,
  orchestratorTools: ToolRegistry,
  goal: string,
  maxIterations: number,
  renderers: GoalRunRenderers,
): Promise<RunLoopResult> {
  const startedAt = Date.now();
  let iterationsUsed = 0;

  try {
    const result = await runAgentLoop({
      client: session.client,
      tools: orchestratorTools,
      checkpointLog: session.checkpointLog,
      scratchpad: session.scratchpad,
      runDir: session.runDir,
      jobId: "main",
      objective: goal,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      compactionBudgetTokens: session.compactionBudgetTokens,
      maxIterations,
      onEvent: renderers.onEvent,
      onStreamEvent: renderers.onStreamEvent,
      onGenerateStart: renderers.onGenerateStart,
      onContextUpdate: renderers.onContextUpdate,
      onCompaction: renderers.onCompaction,
      onIteration: () => {
        iterationsUsed += 1;
      },
    });
    await finalizeMainRun(session, startedAt, "done", { iterationsUsed });
    return result;
  } catch (error) {
    const finalStatus: RunFinalStatus = error instanceof AgentError && error.kind === "budget_exceeded" ? "budget_exceeded" : "error";
    await finalizeMainRun(session, startedAt, finalStatus, { iterationsUsed });
    throw error;
  }
}

async function runAutonomous(goal: string, options: CliOptions): Promise<void> {
  const session = await setUpSession(options, "autonomous");
  if (!session) return;
  const { orchestratorTools } = buildToolRegistries(session, renderEvent);

  try {
    const result = await runGoalWithSession(session, orchestratorTools, goal, Number(options.maxIterations), {
      onEvent: renderEvent,
      onStreamEvent: renderStreamEvent,
    });
    console.log(styleText("bold", "\n\nGoal complete.\n"));
    console.log(result.summary);
  } catch (error) {
    if (error instanceof AgentError) {
      console.error(styleText("red", `\n\nRun did not complete: ${error.message}`));
    } else {
      console.error(styleText("red", "\n\nUnexpected failure:"), error);
    }
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Interactive mode
// ---------------------------------------------------------------------------

/** `/goal <task>` — the REPL's route into the autonomous infinite loop (compaction + completion
 * check: the machinery the task spec is actually about), so the user never has to relaunch with
 * a CLI arg. Reuses the live session (one run dir, one checkpoint log), renders through the
 * same channels as chat turns, and always returns to the prompt — a failed goal run ends the
 * run, never the session. */
async function runGoalFromRepl(session: Session, orchestratorTools: ToolRegistry, goal: string, maxIterations: number): Promise<void> {
  // The submitted command lands in the permanent transcript styled as a command: `/goal` in
  // bold (emphasis channel — this is a mode switch, not chat text), the action framing in
  // orange (the channel every action uses). The goal goes on a tree-style detail line under
  // it, truncated like any tool call's detail — the full text sits right above in the user's
  // own inverse-video echo and in goal.md, so nothing is hidden. (Live per-word styling while
  // typing isn't possible: readline owns the echo, which is why the prompt's inverse trick is
  // all-or-nothing — the effect has to land at submit time.)
  printPermanentLines([
    `${orange("⏺ ")}${styleText("bold", "/goal")}${orange(" — launching autonomous run")}`,
    orange(`  └ ${truncateDetail(goal)}`),
  ]);
  turnStartedAt = Date.now();
  toolTally = new Map();
  let goalCompactions = 0; // this run's own count — the session-wide one belongs to chat turns
  startTurnTicker();

  try {
    // Fresh goal state, unconditionally. runAgentLoop's intake trusts an existing goal.md
    // as-is (that's the --run-id resume path), but this runDir's goal.md may hold the chat
    // session's own first-message intake — without clearing it, the autonomous run and its
    // completion check would chase that stale chat message instead of this goal. context.md
    // goes with it: a prior compaction's working notes belong to whatever goal produced them.
    await writeGoal(session.runDir, "");
    await writeContext(session.runDir, "");

    const result = await runGoalWithSession(session, orchestratorTools, goal, maxIterations, {
      onEvent: renderMainJobEvent,
      onStreamEvent: renderInteractiveStreamEvent,
      onGenerateStart: () => setSpinnerVerb(`${pickThinkingVerb()}…`),
      onContextUpdate: (used) => {
        latestContextTokens = used;
        redrawStatus();
      },
      onCompaction: (contextMd, mergedTurns, archivePointer) => {
        goalCompactions += 1;
        printPermanentLines(renderCompactionSummary(contextMd, mergedTurns, archivePointer));
      },
    });
    printPermanentLines(["", styleText("bold", "Goal complete."), "", result.summary]);
    printPermanentLines(
      [formatTurnSummary(Date.now() - turnStartedAt, toolTally, latestContextTokens, session.compactionBudgetTokens, goalCompactions)],
      orange,
    );
  } catch (error) {
    if (error instanceof AgentError) {
      printPermanentLines([styleText("red", `Run did not complete: ${error.message}`)]);
    } else {
      printPermanentLines([styleText("red", `Run ended on an unexpected failure: ${error instanceof Error ? error.message : String(error)}`)]);
    }
  } finally {
    stopTurnTicker();
    clearSpinner();
  }
}

async function runInteractive(options: CliOptions): Promise<void> {
  const session = await setUpSession(options, "interactive");
  if (!session) return;
  const { orchestratorTools } = buildToolRegistries(session, (line) => renderSubagentEvent(line, "main"));

  const sessionStartedAt = Date.now();
  let totalTurns = 0;

  interactiveAtLineStart = true;
  currentVerb = "";
  subagentEphemeralStatus.clear();
  toolTally = new Map();
  latestContextTokens = 0;
  compactionCount = 0;
  turnStartedAt = 0;
  statusRegion = new EphemeralRegion(process.stdout, process.stdout.isTTY === true);

  printInteractiveLine(styleText("bold", "Rocket Agent — interactive session"));
  printInteractiveLine();
  printInteractiveLine("Type a message to chat, or '/goal <task>' to run it autonomously to completion. Type 'exit' or press Ctrl+C to end the session.");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // rl.close() alone never settles a pending question() — Node only resolves/rejects it on a
  // "line" event or an aborted signal, so without this, Ctrl+C at the prompt hung indefinitely
  // (confirmed live: the process only died via Node's own unsettled-top-level-await watchdog,
  // never printing "Session ended."). An AbortSignal is the documented way to cancel a pending
  // question() (Node's own readline/promises docs show exactly this pattern).
  const sigint = new AbortController();
  rl.on("SIGINT", () => sigint.abort());

  // `readInput` is a hoisted function declaration, so TS discards the early-return narrowing
  // on `session` inside it (it could, in principle, be called before the guard). Bind the
  // post-guard value under a name whose declared type is already non-undefined.
  const activeSession = session;

  async function readInput(): Promise<string | null> {
    // `/goal` lines are handled entirely inside this loop — the turn driver below only ever
    // sees genuine chat input, so a goal run never becomes a "turn" in its buffer.
    for (;;) {
      let answer: string;
      try {
        clearSpinner();
        printInteractiveLine();
        answer = await rl.question(highlightedPrompt("› "), { signal: sigint.signal });
        if (supportsColor) process.stdout.write(ANSI_RESET); // end the prompt's unclosed inverse styling
        interactiveAtLineStart = false; // the terminal's own echo of the typed line has no tracked newline
      } catch {
        return null;
      }

      const goalText = parseGoalCommand(answer);
      if (goalText === undefined) {
        if (answer.trim().length > 0) {
          turnStartedAt = Date.now();
          toolTally = new Map();
          startTurnTicker();
        }
        return answer;
      }
      if (goalText.length === 0) {
        printPermanentLines([`Usage: ${styleText("bold", "/goal")} <task> — runs the task autonomously until it's complete.`]);
        continue;
      }
      await runGoalFromRepl(activeSession, orchestratorTools, goalText, Number(options.maxIterations));
      // …then loop back to the prompt; the chat session resumes exactly where it left off.
    }
  }

  try {
    await runInteractiveSession({
      client: session.client,
      tools: orchestratorTools,
      checkpointLog: session.checkpointLog,
      scratchpad: session.scratchpad,
      runDir: session.runDir,
      jobId: "main",
      systemPrompt: INTERACTIVE_SYSTEM_PROMPT,
      compactionBudgetTokens: session.compactionBudgetTokens,
      maxIterationsPerTurn: Number(options.maxIterationsPerTurn),
      readInput,
      onTurnResponse: (text) => printPermanentLines([text]),
      onTurnError: (message) => printPermanentLines([styleText("red", `Error: ${message}`)]),
      // No onEvent here: this job's own events (the only one is "[main] compacting", which fires
      // right before onCompaction's much richer summary anyway) have nothing useful left to add.
      // Subagent activity is routed separately, at dispatch-tool construction time — see
      // buildToolRegistries's onDispatchEvent.
      onToolCall: renderToolCall,
      onStreamEvent: renderInteractiveStreamEvent,
      onGenerateStart: () => setSpinnerVerb(`${pickThinkingVerb()}…`),
      onContextUpdate: (used) => {
        latestContextTokens = used;
        redrawStatus(); // token count is part of the live status line now, not just the end summary
      },
      onCompaction: (contextMd, mergedTurns, archivePointer) => {
        compactionCount += 1;
        printPermanentLines(renderCompactionSummary(contextMd, mergedTurns, archivePointer));
      },
      onTurnEnd: () => {
        stopTurnTicker();
        totalTurns += 1;
        // Agent stats (time/tools/tokens/context-fill/compactions) — orange, same channel as tool
        // calls. Was plain white: this call site never passed the style argument at all.
        printPermanentLines([formatTurnSummary(Date.now() - turnStartedAt, toolTally, latestContextTokens, session.compactionBudgetTokens, compactionCount)], orangeItalic);
      },
    });
  } catch (error) {
    // Mirrors runAutonomous's handling — without this, an exception escaping session.ts's own
    // internal handling propagated past this directly-awaited call as an uncaught exception
    // (confirmed: process.on("unhandledRejection") does not catch a directly-awaited rejection),
    // printing a raw stack trace instead of the same friendly message the autonomous mode gives.
    clearSpinner();
    if (error instanceof AgentError) {
      console.error(styleText("red", `\nSession ended on an error: ${error.message}`));
    } else {
      console.error(styleText("red", "\nSession ended on an unexpected failure:"), error);
    }
    await finalizeMainRun(session, sessionStartedAt, "error", { totalTurns });
    process.exitCode = 1;
    return;
  } finally {
    stopTurnTicker();
    rl.close();
  }

  await finalizeMainRun(session, sessionStartedAt, "interactive_session_ended", { totalTurns });
  printInteractiveLine();
  printInteractiveLine("Session ended.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(goal: string | undefined, options: CliOptions): Promise<void> {
  const trimmedGoal = goal?.trim();
  if (trimmedGoal) {
    await runAutonomous(trimmedGoal, options);
  } else {
    await runInteractive(options);
  }
}

process.on("unhandledRejection", (reason) => {
  console.error(styleText("red", "Unhandled rejection:"), reason);
  process.exitCode = 1;
});

const program = new Command();
program
  .name("rocket-agent")
  .description(
    "Infinite-running agent: runs until its goal is complete across arbitrary context-window boundaries. " +
      "Pass a goal for the autonomous unattended mode, or omit it for an interactive session.",
  )
  .argument("[goal]", "the goal for the agent to accomplish, autonomous mode (quote it if it has spaces). Omit for an interactive session.")
  .option("--model <id>", "Anthropic model id (default: the model client's own default)")
  .option("--effort <level>", "low|medium|high|xhigh|max (default: medium)")
  .option("--max-iterations <n>", "autonomous mode: top-level iteration cap", "120")
  .option("--max-iterations-per-turn <n>", "interactive mode: per-turn iteration cap", "30")
  .option("--subagent-max-iterations <n>", "per-subagent iteration cap", "20")
  .option("--max-concurrent-subagents <n>", "cap on subagents running at once via dispatch_subagents", "4")
  .option("--compaction-budget <tokens>", "token budget that triggers compaction", "25000")
  .option("--run-id <id>", "reuse an existing run directory instead of starting a new one")
  .action(main);

await program.parseAsync();
