import { describe, expect, it } from "vitest";
import { EphemeralRegion } from "../src/cli/ephemeralRegion.js";

function makeFakeStream(): { stream: NodeJS.WritableStream; writes: string[] } {
  const writes: string[] = [];
  const stream = { write: (chunk: string) => (writes.push(chunk), true) } as unknown as NodeJS.WritableStream;
  return { stream, writes };
}

describe("EphemeralRegion (interactive)", () => {
  it("writes new content directly on the first update, with no clearing beforehand", () => {
    const { stream, writes } = makeFakeStream();
    const region = new EphemeralRegion(stream, true);
    region.update(["Thinking... 1s"]);
    expect(writes).toEqual(["Thinking... 1s"]);
  });

  it("clears the previous single line before writing the next one", () => {
    // A fake stream is just a byte log -- every byte ever written stays in it, the same as a
    // real terminal's own scrollback buffer would still technically hold them. What actually
    // produces the *visible* overwrite effect is the write *sequence*: content, then cursor-
    // clearing control codes, then the new content in the same place -- that's what this checks.
    const { stream, writes } = makeFakeStream();
    const region = new EphemeralRegion(stream, true);
    region.update(["Thinking... 1s"]);
    region.update(["write_file(hello.txt)"]);
    expect(writes[0]).toBe("Thinking... 1s");
    expect(writes.slice(1, -1).some((w) => w.startsWith("\x1b"))).toBe(true);
    expect(writes.at(-1)).toBe("write_file(hello.txt)");
  });

  it("clears every row when shrinking from N lines to fewer", () => {
    const { stream, writes } = makeFakeStream();
    const region = new EphemeralRegion(stream, true);
    region.update(["[a] working", "[b] working", "[c] working"]);
    writes.length = 0; // only care about the clear+redraw from here
    region.update(["[a] done"]);
    // Every write before the final content write is a cursor-control escape sequence (starts
    // with ESC, 0x1B) — using an explicit \x1b literal here rather than a pasted-in raw control
    // byte, so this stays legible and doesn't silently depend on an invisible character in the
    // source (a mistake made once already while drafting this file).
    const controlWrites = writes.filter((w) => w.startsWith("\x1b"));
    expect(controlWrites.length).toBeGreaterThanOrEqual(6); // 3 old rows x (cursorTo + clearLine)
    expect(writes.join("")).toContain("[a] done");
    expect(writes.join("")).not.toContain("working");
  });

  it("applies an optional style function after truncation, not before", () => {
    const { stream, writes } = makeFakeStream();
    const region = new EphemeralRegion(stream, true);
    // A style wrapper adds bytes that must not count toward the truncation width — if it were
    // applied before truncating, this would cut off real content too early.
    const wrap = (line: string): string => `<<${line}>>`;
    region.update(["hello"], wrap);
    expect(writes.join("")).toBe("<<hello>>");
  });

  it("style is applied to the truncated (not full) text, for content over the width cap", () => {
    const { stream, writes } = makeFakeStream();
    const region = new EphemeralRegion(stream, true);
    const wrap = (line: string): string => `[${line}]`;
    region.update(["x".repeat(500)], wrap);
    const combined = writes.join("");
    expect(combined.startsWith("[") && combined.endsWith("]")).toBe(true);
    expect(combined.length).toBeLessThan(150); // proves truncation happened, style didn't prevent it
  });

  it("clear() removes the region and resets isActive", () => {
    const { stream } = makeFakeStream();
    const region = new EphemeralRegion(stream, true);
    region.update(["something"]);
    expect(region.isActive).toBe(true);
    region.clear();
    expect(region.isActive).toBe(false);
  });

  it("clear() on an already-empty region is a safe no-op", () => {
    const { stream, writes } = makeFakeStream();
    const region = new EphemeralRegion(stream, true);
    region.clear();
    expect(writes).toEqual([]);
  });

  it("truncates a line longer than the safe width, so it can never wrap across rows", () => {
    const { stream, writes } = makeFakeStream();
    const region = new EphemeralRegion(stream, true);
    region.update(["x".repeat(500)]);
    expect(writes.join("").length).toBeLessThan(150);
    expect(writes.join("").length).toBeLessThan(500); // proves it was actually truncated, not just passed through
  });
});

describe("EphemeralRegion (non-interactive / piped output)", () => {
  it("prints each update as plain sequential lines instead of overwriting", () => {
    const { stream, writes } = makeFakeStream();
    const region = new EphemeralRegion(stream, false);
    region.update(["Thinking... 1s"]);
    region.update(["write_file(hello.txt)"]);
    // Both states are preserved as plain output -- no cursor-control codes, no data loss.
    const combined = writes.join("");
    expect(combined).toContain("Thinking... 1s");
    expect(combined).toContain("write_file(hello.txt)");
    expect(combined).not.toContain("\x1b");
  });

  it("clear() is a no-op (nothing to un-overwrite in plain sequential mode)", () => {
    const { stream, writes } = makeFakeStream();
    const region = new EphemeralRegion(stream, false);
    region.update(["something"]);
    writes.length = 0;
    region.clear();
    expect(writes).toEqual([]);
  });
});
