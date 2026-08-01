import { styleText } from "node:util";

// Pure string-building only — no console.log/process.stdout.write here. Kept separate from
// cli.ts specifically so these are unit-testable without touching cli.ts's own top-level
// `await program.parseAsync()`, which would otherwise fire on import.
//
// Palette: solid black/white only (the terminal's own background is black; text is either
// plain-default (renders white) or bold-white). No "dim" — it renders as a washed-out gray that
// reads poorly against a plain black background. `red` is the one exception, reserved for
// actual errors in cli.ts.

export interface ToolActivity {
  /** A short verb-phrase describing what's happening, e.g. "Running shell command…" — shown on
   * the status line itself. */
  summary: string;
  /** The specific argument (a path, a command, a pattern) — shown on its own indented line
   * underneath the summary, tree-style, rather than crammed into one line. */
  detail?: string;
}

// Every tool call now prints as a *permanent* line (never overwritten — see cli.ts), so unlike
// the old ephemeral-only version, there's no automatic 100-char cap from EphemeralRegion to fall
// back on. Without one, a long shell command wraps at the terminal's own width with no hanging
// indent — the wrapped continuation lands flush at column 0, breaking the left-aligned "└ "
// tree look (observed live). Capping here keeps every detail line short enough to never wrap on
// a normal-width terminal — full tool-call visibility is preserved (nothing is hidden or
// summarized away), only a single very long argument gets shortened for display.
const MAX_DETAIL_CHARS = 90;

/** Exported for cli.ts's `/goal` launch line, which renders the goal text itself as a
 * tree-style detail line under the command header — same cap, same reason (never wraps). */
export function truncateDetail(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS - 1)}…` : text;
}

/** Tool name + its single most relevant input field, split into a verb-phrase summary and the
 * specific argument as a separate detail line — e.g. "Writing file…" / "src/db.js" — instead of
 * one crammed "write_file(src/db.js)" line. */
export function formatToolActivity(name: string, input: unknown): ToolActivity {
  const obj = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  switch (name) {
    case "read_file":
      return { summary: "Reading file…", detail: truncateDetail(String(obj.path ?? "")) };
    case "write_file":
      return { summary: "Writing file…", detail: truncateDetail(String(obj.path ?? "")) };
    case "edit_file":
      return { summary: "Editing file…", detail: truncateDetail(String(obj.path ?? "")) };
    case "list_dir":
      return { summary: "Listing directory…", detail: truncateDetail(String(obj.path ?? ".")) };
    case "search":
      return {
        summary: "Searching…",
        detail: truncateDetail(`${JSON.stringify(String(obj.pattern ?? ""))} in ${String(obj.path ?? ".")}`),
      };
    case "run_command":
      return { summary: "Running shell command…", detail: truncateDetail(`$ ${String(obj.command ?? "")}`) };
    case "read_scratchpad":
      return { summary: "Reading scratchpad…", detail: truncateDetail(String(obj.pointer ?? "")) };
    case "request_human_input":
      return { summary: "Asking a question…", detail: truncateDetail(String(obj.question ?? "")) };
    case "dispatch_subagents": {
      const subtasks = Array.isArray(obj.subtasks) ? obj.subtasks : [];
      const ids = subtasks
        .map((subtask) => (typeof subtask === "object" && subtask !== null ? String((subtask as Record<string, unknown>).jobId ?? "?") : "?"))
        .join(", ");
      return { summary: `Dispatching ${subtasks.length} subagent${subtasks.length === 1 ? "" : "s"}…`, detail: truncateDetail(ids) };
    }
    default:
      return { summary: `Running ${name}…` };
  }
}

/** Rotated (randomly, by the caller) instead of a static "Thinking…" label for every wait — the
 * actual picking (Math.random()) isn't pure, so it stays in cli.ts; this is just the pool. Rocket's
 * own set, not Claude Code's specific vocabulary — same idea (varied, single-word, present-
 * participle), different words, since this is a different product with its own voice. */
export const THINKING_VERBS: readonly string[] = [
  "Reasoning",
  "Planning",
  "Analyzing",
  "Synthesizing",
  "Deliberating",
  "Processing",
  "Formulating",
  "Strategizing",
  "Computing",
  "Considering",
];

/** "45s" under a minute, "2m 15s" at or above — matches the "how many minutes did it work"
 * framing directly rather than always showing raw seconds. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/** The one place all the end-of-turn numbers (time, tools, context fill, compactions) come
 * together — replaces a live-updating gauge and a growing per-tool-call log with a single line
 * shown once the turn is actually over. The leading `*` marks it as a synthetic stats line,
 * visually distinct from the agent's own streamed text and tool-call lines.
 *
 * `contextTokens` is the active context-window fill from the last API call; `contextBudget` is
 * the compaction threshold, so `context used/budget (pct%)` reads as "how close to the next
 * compaction". `compactionCount` is the running number of compactions this session has done. */
export function formatTurnSummary(
  elapsedMs: number,
  toolTally: ReadonlyMap<string, number>,
  contextTokens: number,
  contextBudget: number,
  compactionCount: number,
): string {
  const toolsPart =
    toolTally.size > 0 ? [...toolTally.entries()].map(([name, count]) => `${name}×${count}`).join(", ") : "no tool calls";
  const pct = contextBudget > 0 ? Math.round((contextTokens / contextBudget) * 100) : 0;
  const compactionPart = `${compactionCount} compaction${compactionCount === 1 ? "" : "s"}`;
  return `* Thought for ${formatElapsed(elapsedMs)} · ${toolsPart} · ${contextTokens.toLocaleString()} tokens · context ${contextTokens.toLocaleString()}/${contextBudget.toLocaleString()} (${pct}%) · ${compactionPart}`;
}

/** Splits a REPL input line into the `/goal` command and its payload. Returns undefined for
 * ordinary chat input (so callers can branch on command-vs-chat with one check), "" for a bare
 * `/goal` with no task (a usage error the caller reports), and the trimmed task text otherwise.
 * Anchored so "/goalkeeper"-style chat text is never mistaken for the command. */
export function parseGoalCommand(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === "/goal") return "";
  if (trimmed.startsWith("/goal ")) return trimmed.slice("/goal ".length).trim();
  return undefined;
}

const MAX_COMPACTION_DISPLAY_LINES = 40;

/** Shows the actual merged context.md, not just a "compacting..." marker — full transparency
 * into the one mechanism this whole project exists to prove. Boxless: a bold header line, then
 * the compacted document indented under it. */
export function renderCompactionSummary(contextMd: string, mergedTurns: number, archivePointer: string): string[] {
  const header = styleText("bold", `Compacting context — ${mergedTurns} turns merged, archived at ${archivePointer}`);
  const bodyLines = contextMd.split("\n");
  const shown = bodyLines.slice(0, MAX_COMPACTION_DISPLAY_LINES);
  const lines = [header, "", ...shown.map((line) => `  ${line}`)];
  if (bodyLines.length > MAX_COMPACTION_DISPLAY_LINES) {
    lines.push(`  … ${bodyLines.length - MAX_COMPACTION_DISPLAY_LINES} more lines (see context.md)`);
  }
  return lines;
}
