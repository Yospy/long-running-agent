import { describe, expect, it } from "vitest";
import { THINKING_VERBS, formatElapsed, formatToolActivity, formatTurnSummary, parseGoalCommand, renderCompactionSummary } from "../src/cli/render.js";

describe("formatToolActivity", () => {
  it("splits file tools into a verb-phrase summary and the path as a separate detail", () => {
    expect(formatToolActivity("write_file", { path: "src/db.js", content: "..." })).toEqual({
      summary: "Writing file…",
      detail: "src/db.js",
    });
    expect(formatToolActivity("read_file", { path: "package.json" })).toEqual({
      summary: "Reading file…",
      detail: "package.json",
    });
  });

  it("shows the shell command as the detail line, prefixed like a real command", () => {
    const activity = formatToolActivity("run_command", { command: "npm test" });
    expect(activity.summary).toBe("Running shell command…");
    expect(activity.detail).toBe("$ npm test");
  });

  it("summarizes dispatch_subagents with the subtask count, and jobIds as the detail", () => {
    const activity = formatToolActivity("dispatch_subagents", {
      subtasks: [{ jobId: "create", objective: "..." }, { jobId: "list", objective: "..." }],
    });
    expect(activity.summary).toBe("Dispatching 2 subagents…");
    expect(activity.detail).toBe("create, list");
  });

  it("falls back to a generic 'Running <name>…' summary, no detail, for an unrecognized tool", () => {
    expect(formatToolActivity("some_future_tool", { anything: true })).toEqual({ summary: "Running some_future_tool…" });
  });

  // Regression: tool calls now print as permanent lines (never overwritten), so a long shell
  // command has no automatic cap from EphemeralRegion anymore — observed live wrapping at the
  // terminal's own width with no hanging indent, breaking the left-aligned "└ " look. A long
  // detail must still get shortened for display, even though the tool call itself is never
  // hidden or summarized away.
  it("truncates a very long detail line so it can never wrap on a normal-width terminal", () => {
    const activity = formatToolActivity("run_command", { command: "x".repeat(300) });
    expect(activity.detail?.length).toBeLessThan(100);
    expect(activity.detail?.endsWith("…")).toBe(true);
    expect(activity.detail?.startsWith("$ ")).toBe(true);
  });
});

describe("THINKING_VERBS", () => {
  it("is a non-empty list of distinct, non-blank words", () => {
    expect(THINKING_VERBS.length).toBeGreaterThan(1);
    expect(new Set(THINKING_VERBS).size).toBe(THINKING_VERBS.length);
    for (const verb of THINKING_VERBS) expect(verb.trim().length).toBeGreaterThan(0);
  });
});

describe("formatElapsed", () => {
  it("shows plain seconds under a minute", () => {
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(0)).toBe("0s");
  });

  it("shows minutes and seconds at or above a minute", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(135_000)).toBe("2m 15s");
  });

  it("never returns a negative duration for a clock skew of a few ms", () => {
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("formatTurnSummary", () => {
  it("includes elapsed time, a compact tool tally, the token count, context fill vs. budget, and compaction count, with a `*` prefix", () => {
    const summary = formatTurnSummary(12_000, new Map([["write_file", 2], ["run_command", 1]]), 3240, 25000, 0);
    expect(summary.startsWith("* ")).toBe(true);
    expect(summary).toContain("Thought for 12s");
    expect(summary).toContain("write_file×2");
    expect(summary).toContain("run_command×1");
    expect(summary).toContain("3,240 tokens");
    expect(summary).toContain("context 3,240/25,000 (13%)");
    expect(summary).toContain("0 compactions");
  });

  it("says so plainly when no tools were called, and pluralizes compactions correctly at 1", () => {
    const summary = formatTurnSummary(3_000, new Map(), 500, 25000, 1);
    expect(summary).toContain("no tool calls");
    expect(summary).toContain("1 compaction");
    expect(summary).not.toContain("1 compactions");
  });
});

describe("parseGoalCommand", () => {
  it("returns the task text for '/goal <task>', trimmed", () => {
    expect(parseGoalCommand("/goal build an API")).toBe("build an API");
    expect(parseGoalCommand("  /goal   build an API  ")).toBe("build an API");
  });

  it("returns an empty string for a bare '/goal' (a usage error the caller reports)", () => {
    expect(parseGoalCommand("/goal")).toBe("");
    expect(parseGoalCommand("  /goal  ")).toBe("");
  });

  it("returns undefined for ordinary chat input, including look-alikes", () => {
    expect(parseGoalCommand("build an API")).toBeUndefined();
    expect(parseGoalCommand("")).toBeUndefined();
    expect(parseGoalCommand("/goalkeeper tactics")).toBeUndefined();
    expect(parseGoalCommand("what does /goal do?")).toBeUndefined();
  });
});

describe("renderCompactionSummary", () => {
  it("includes the merge stats, the archive pointer, and the actual compacted text", () => {
    const lines = renderCompactionSummary("## Goal (restated)\n\nBuild X\n\n## Next planned step\n\nDone.", 5, "main:abc123");
    const joined = lines.join("\n");
    expect(joined).toContain("5 turns merged");
    expect(joined).toContain("main:abc123");
    expect(joined).toContain("Build X");
    expect(joined).toContain("Next planned step");
  });

  it("caps the number of displayed lines for a very long compacted document", () => {
    const longContext = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const lines = renderCompactionSummary(longContext, 1, "main:x");
    const joined = lines.join("\n");
    expect(joined).toContain("more lines");
    expect(joined).not.toContain("line 99");
  });

  it("has no box-drawing characters — the redesign dropped bordered boxes entirely", () => {
    const lines = renderCompactionSummary("## Goal\n\nX", 1, "main:x");
    const joined = lines.join("\n");
    expect(joined).not.toMatch(/[┌┐└┘│─╭╮╰╯]/);
  });
});
