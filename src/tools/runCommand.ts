import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool } from "./registry.js";
import { AgentError } from "../errors/taxonomy.js";

const runCommandSchema = z.object({ command: z.string() });

const HARD_TIMEOUT_MS = 60_000;
const GRACE_PERIOD_MS = 5_000;
const MAX_OUTPUT_CHARS = 20_000;

export function makeRunCommandTool(cwd: string): Tool<z.infer<typeof runCommandSchema>> {
  return {
    definition: {
      name: "run_command",
      description:
        "Run a shell command with its working directory set to the project root, and return its combined " +
        "stdout/stderr. The working directory is set via cwd only, not a real sandbox — stay within the " +
        "project root; do not use '..', absolute paths, or symlinks to reach files outside it (an absolute " +
        "`cd` target or an absolute path as the command itself is rejected before it runs). Runs under " +
        "`set -o pipefail`, so a failing command earlier in a `|` pipeline is reflected in the reported exit " +
        "code even when piped through `tail`/`head`/`grep`. That does NOT apply across `;`/`&&`/`||` — each " +
        "semicolon/and/or-separated statement has its own independent exit code, and only the LAST one is " +
        "reported. If you chain a diagnostic command (e.g. `echo`, `grep`) after the command you actually " +
        "care about, check that command's own exit code (e.g. `echo \"exit=$?\"`) immediately after it, " +
        "before any further diagnostics — otherwise a later, unrelated statement's exit code overwrites the " +
        "real pass/fail signal.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command to execute" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
    schema: runCommandSchema,
    execute: ({ command }) => runWithHardTimeout(command, cwd),
  };
}

function runWithHardTimeout(command: string, cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Explicit /bin/bash (not shell: true's default /bin/sh) so `pipefail` is available — without
    // it, a failing command piped through `tail`/`head`/`grep` reports the *pipe's* exit code
    // (i.e. tail's, always 0), silently hiding a real failure from the model.
    const child = spawn(`set -o pipefail; ${command}`, { cwd, shell: "/bin/bash" });
    let output = "";
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const killTimer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), GRACE_PERIOD_MS);
    }, HARD_TIMEOUT_MS);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      rejectPromise(
        new AgentError({
          kind: "execution",
          message: `Failed to run command: ${error.message}`,
          recoverable: true,
          cause: error,
        }),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const truncated = output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]` : output;
      if (code === 0) {
        resolvePromise(truncated || "(no output)");
      } else {
        rejectPromise(
          new AgentError({
            kind: "execution",
            message: `Command exited with code ${code}`,
            recoverable: true,
            details: { exitCode: code, output: truncated },
          }),
        );
      }
    });
  });
}
