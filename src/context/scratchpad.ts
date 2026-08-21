import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ScratchPointer {
  jobId: string;
  id: string;
}

/** The actual bytes behind checkpoint/context pointers, namespaced per job. */
export class Scratchpad {
  constructor(private readonly rootDir: string) {}

  private pathFor(pointer: ScratchPointer): string {
    return join(this.rootDir, pointer.jobId, `${pointer.id}.txt`);
  }

  async write(jobId: string, content: string): Promise<ScratchPointer> {
    const pointer: ScratchPointer = { jobId, id: randomUUID() };
    await mkdir(join(this.rootDir, jobId), { recursive: true });
    await writeFile(this.pathFor(pointer), content, "utf8");
    return pointer;
  }

  async read(pointer: ScratchPointer): Promise<string> {
    return readFile(this.pathFor(pointer), "utf8");
  }
}

export function pointerToString(pointer: ScratchPointer): string {
  return `${pointer.jobId}:${pointer.id}`;
}

export function parsePointer(value: string): ScratchPointer {
  const [jobId, id] = value.split(":");
  if (!jobId || !id) {
    throw new Error(`Malformed scratchpad pointer: ${value}`);
  }
  return { jobId, id };
}

/** ~500 tokens at ~4 chars/token, per the sprint doc's routing threshold. */
export const INLINE_CHAR_THRESHOLD = 2000;

export interface RoutedOutput {
  /** What goes into both the in-context buffer and the checkpoint log — never the raw bytes twice. */
  text: string;
  scratchPointer?: string;
}

/** Wraps tool output in `<tool_output>` tags so the model can distinguish data from instructions —
 * the system prompt tells it to treat everything inside these tags as untrusted text, never as
 * commands. Applied here (the one choke point every successful tool result flows through) so no
 * tool can bypass it. */
function wrapToolOutput(text: string): string {
  return `<tool_output>\n${text}\n</tool_output>`;
}

export async function routeToolOutput(
  scratchpad: Scratchpad,
  jobId: string,
  output: string,
): Promise<RoutedOutput> {
  if (output.length <= INLINE_CHAR_THRESHOLD) {
    return { text: wrapToolOutput(output) };
  }
  const pointer = await scratchpad.write(jobId, output);
  const scratchPointer = pointerToString(pointer);
  const preview = output.slice(0, 200).replace(/\s+/g, " ").trim();
  return {
    text: wrapToolOutput(
      `[Output too large for context: ${output.length} chars, stored at scratchpad pointer ${scratchPointer}]\n` +
        `Preview: ${preview}...\n` +
        "Use read_scratchpad with this pointer if you need the full content.",
    ),
    scratchPointer,
  };
}
