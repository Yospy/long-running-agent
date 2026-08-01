import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRunCommandTool } from "../src/tools/runCommand.js";
import { AgentError } from "../src/errors/taxonomy.js";

describe("run_command", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "rocket-runcommand-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("returns combined stdout/stderr for a successful command", async () => {
    const tool = makeRunCommandTool(cwd);
    const output = await tool.execute({ command: "echo hello" }, { runDir: cwd, jobId: "j" });
    expect(output).toContain("hello");
  });

  it("rejects with the exit code when the command fails", async () => {
    const tool = makeRunCommandTool(cwd);
    await expect(tool.execute({ command: "exit 3" }, { runDir: cwd, jobId: "j" })).rejects.toMatchObject({
      message: expect.stringContaining("exited with code 3"),
    });
  });

  // Regression: confirmed live — `tsc --noEmit | tail -30` reported success (exit 0) even when
  // tsc itself found real type errors, because the default shell (/bin/sh, no pipefail) reports
  // only the last stage's (tail's) exit code. `false | true` is the minimal reproduction: without
  // pipefail this "succeeds" (true's exit code wins); with it, the pipeline correctly fails.
  it("reflects a failing command earlier in a pipe (pipefail), not just the last stage", async () => {
    const tool = makeRunCommandTool(cwd);
    await expect(tool.execute({ command: "false | tail -1" }, { runDir: cwd, jobId: "j" })).rejects.toThrow(AgentError);
  });

  it("still succeeds when every stage of a pipe succeeds", async () => {
    const tool = makeRunCommandTool(cwd);
    const output = await tool.execute({ command: "echo hello | tail -1" }, { runDir: cwd, jobId: "j" });
    expect(output.trim()).toBe("hello");
  });

  it("runs with cwd set to the given directory", async () => {
    const tool = makeRunCommandTool(cwd);
    const output = await tool.execute({ command: "pwd" }, { runDir: cwd, jobId: "j" });
    // pwd (no -L) reports the physical path — on macOS /tmp is itself a symlink to /private/tmp,
    // so cwd and the command's own reported path must both be canonicalized before comparing.
    expect(await realpath(output.trim())).toBe(await realpath(cwd));
  });
});
