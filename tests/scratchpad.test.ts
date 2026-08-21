import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INLINE_CHAR_THRESHOLD, Scratchpad, parsePointer, pointerToString, routeToolOutput } from "../src/context/scratchpad.js";

describe("routeToolOutput", () => {
  let dir: string;
  let scratchpad: Scratchpad;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rocket-scratch-"));
    scratchpad = new Scratchpad(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps small output inline, wrapped in <tool_output> tags, with no scratchpad write", async () => {
    const routed = await routeToolOutput(scratchpad, "job-1", "short output");
    expect(routed.text).toBe("<tool_output>\nshort output\n</tool_output>");
    expect(routed.scratchPointer).toBeUndefined();
  });

  it("routes large output to the scratchpad and returns a fetchable pointer, still wrapped in <tool_output> tags", async () => {
    const big = "x".repeat(INLINE_CHAR_THRESHOLD + 1);
    const routed = await routeToolOutput(scratchpad, "job-1", big);

    expect(routed.scratchPointer).toBeDefined();
    expect(routed.text).toContain("<tool_output>");
    expect(routed.text).toContain("</tool_output>");
    expect(routed.text).toContain(routed.scratchPointer as string);

    const fetched = await scratchpad.read(parsePointer(routed.scratchPointer as string));
    expect(fetched).toBe(big);
  });

  it("round-trips a pointer through its string form", async () => {
    const pointer = await scratchpad.write("job-2", "hello");
    expect(parsePointer(pointerToString(pointer))).toEqual(pointer);
  });
});
