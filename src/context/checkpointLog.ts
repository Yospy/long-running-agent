import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";

export type CheckpointEventType =
  | "state_transition"
  | "tool_call"
  | "tool_result"
  | "compaction"
  | "usage"
  | "run_end"
  | "error";

export interface CheckpointEntry {
  seq: number;
  jobId: string;
  type: CheckpointEventType;
  timestamp: string;
  payload: unknown;
}

/** Append-only JSONL log. One line per state transition, tool call/result, and compaction event. */
export class CheckpointLog {
  private constructor(
    private readonly filePath: string,
    private seq: number,
  ) {}

  /** Reads any existing log to resume the sequence counter, so a restarted process never reuses a seq. */
  static async open(filePath: string): Promise<CheckpointLog> {
    const existing = existsSync(filePath) ? await readEntries(filePath) : [];
    const nextSeq = existing.length > 0 ? Math.max(...existing.map((entry) => entry.seq)) + 1 : 0;
    return new CheckpointLog(filePath, nextSeq);
  }

  async append(jobId: string, type: CheckpointEventType, payload: unknown): Promise<CheckpointEntry> {
    const entry: CheckpointEntry = {
      seq: this.seq++,
      jobId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  async readAll(): Promise<CheckpointEntry[]> {
    return existsSync(this.filePath) ? readEntries(this.filePath) : [];
  }
}

async function readEntries(filePath: string): Promise<CheckpointEntry[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CheckpointEntry);
}
