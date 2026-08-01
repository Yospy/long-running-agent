import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "../model/client.js";

function goalPath(runDir: string): string {
  return join(runDir, "goal.md");
}

function contextPath(runDir: string): string {
  return join(runDir, "context.md");
}

function compactionSnapshotPath(runDir: string, index: number): string {
  return join(runDir, "compactions", `${String(index).padStart(4, "0")}.md`);
}

export async function readGoal(runDir: string): Promise<string> {
  return existsSync(goalPath(runDir)) ? readFile(goalPath(runDir), "utf8") : "";
}

export async function writeGoal(runDir: string, content: string): Promise<void> {
  await writeFile(goalPath(runDir), content, "utf8");
}

export async function readContext(runDir: string): Promise<string> {
  return existsSync(contextPath(runDir)) ? readFile(contextPath(runDir), "utf8") : "";
}

export async function writeContext(runDir: string, content: string): Promise<void> {
  await writeFile(contextPath(runDir), content, "utf8");
}

/**
 * Writes an ordered, never-overwritten copy of a merged compaction alongside the live
 * `context.md` (which stays overwrite-only — it's still the fast-path read for the next planning
 * call). Without this, only the *last* of a run's N merged summaries survives as a file — every
 * earlier boundary's carried-forward state is otherwise only reconstructable by replaying
 * checkpoint.jsonl. Returns the path relative to runDir, for embedding in that compaction's own
 * checkpoint record.
 */
export async function writeCompactionSnapshot(runDir: string, index: number, contextMd: string): Promise<string> {
  await mkdir(join(runDir, "compactions"), { recursive: true });
  await writeFile(compactionSnapshotPath(runDir, index), contextMd, "utf8");
  return join("compactions", `${String(index).padStart(4, "0")}.md`);
}

/**
 * The 4-layer context window: static system prompt (owned by the caller) + goal.md +
 * context.md, folded into one preamble message, followed by the raw turn buffer.
 */
export function assembleMessages(goalMd: string, contextMd: string, buffer: ModelMessage[]): ModelMessage[] {
  const preamble: ModelMessage = {
    role: "user",
    content: [{ type: "text", text: renderPreamble(goalMd, contextMd) }],
  };
  return [preamble, ...buffer];
}

function renderPreamble(goalMd: string, contextMd: string): string {
  const sections = [`## Goal\n\n${goalMd.trim()}`];
  if (contextMd.trim().length > 0) {
    sections.push(`## Working context (compacted history)\n\n${contextMd.trim()}`);
  }
  sections.push("Continue working toward the goal using the tools available.");
  return sections.join("\n\n");
}

/** Readable rendering of a raw turn buffer — shared by compaction (the merge prompt) and
 * completion-checking (which must see recent work even before the first compaction happens,
 * when context.md is still empty). */
export function renderTranscript(buffer: ModelMessage[]): string {
  return buffer.map((message) => `${message.role}: ${renderMessageContent(message)}`).join("\n\n");
}

function renderMessageContent(message: ModelMessage): string {
  return message.content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "tool_use":
          return `[tool_use ${block.name}] ${JSON.stringify(block.input)}`;
        case "tool_result":
          return `[tool_result${block.isError ? " ERROR" : ""}] ${block.content}`;
        case "opaque":
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}
