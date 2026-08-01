import { z } from "zod";
import type { Tool } from "./registry.js";
import { parsePointer, type Scratchpad } from "../context/scratchpad.js";

const readScratchpadSchema = z.object({ pointer: z.string() });

export function makeReadScratchpadTool(scratchpad: Scratchpad): Tool<z.infer<typeof readScratchpadSchema>> {
  return {
    definition: {
      name: "read_scratchpad",
      description: "Fetch the full raw content behind a scratchpad pointer that appeared in a summarized tool result.",
      inputSchema: {
        type: "object",
        properties: { pointer: { type: "string", description: "Scratchpad pointer, e.g. 'jobId:uuid'" } },
        required: ["pointer"],
        additionalProperties: false,
      },
    },
    schema: readScratchpadSchema,
    execute: async ({ pointer }) => scratchpad.read(parsePointer(pointer)),
  };
}
