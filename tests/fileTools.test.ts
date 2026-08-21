import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeEditFileTool, makeReadFileTool, makeWriteFileTool } from "../src/tools/fileTools.js";
import { AgentError } from "../src/errors/taxonomy.js";

describe("file tools", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rocket-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads back what write_file wrote", async () => {
    const write = makeWriteFileTool(root);
    const read = makeReadFileTool(root);
    await write.execute({ path: "notes.txt", content: "hello" }, { runDir: root, jobId: "j" });
    expect(await read.execute({ path: "notes.txt" }, { runDir: root, jobId: "j" })).toBe("hello");
  });

  it("edit_file rejects an oldText that matches more than once", async () => {
    await writeFile(join(root, "a.txt"), "foo bar foo", "utf8");
    const edit = makeEditFileTool(root);
    await expect(
      edit.execute({ path: "a.txt", oldText: "foo", newText: "baz" }, { runDir: root, jobId: "j" }),
    ).rejects.toThrow(AgentError);
  });

  it("rejects a path that escapes the project root", async () => {
    const read = makeReadFileTool(root);
    await expect(read.execute({ path: "../../etc/passwd" }, { runDir: root, jobId: "j" })).rejects.toThrow(AgentError);
  });
});
