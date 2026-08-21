import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

/** Evaluated once per tool call, for every tool, before execute() — the harness-level gate. */
export interface ToolCallPolicy {
  evaluate(toolName: string, input: unknown): PolicyDecision;
}

/**
 * A tripwire against accidental self-inflicted damage AND deliberate secret/prompt exfiltration —
 * NOT a real security boundary. String matching a shell command can always be routed around by a
 * sufficiently adversarial input; this exists to catch the realistic failure modes for this
 * project (an agent running something destructive by mistake, or reading files outside the
 * workspace that hold the system prompt or API keys), not to defend against a determined attacker.
 * run_command's own description already asks the model to stay inside the workspace; this is the
 * enforced backstop. Only run_command's `command` field is inspected today — every other tool is
 * allowed — but the gate itself runs for all tools, so a per-tool policy can be added later
 * without touching the registry.
 */
const RECURSIVE_FORCE_RM = /\brm\s+(-\w*[rf]\w*[rf]?\w*|--recursive|--force)/i;
const ESCAPES_WORKSPACE = /(^|\s)(\.\.|\/(?!workspace\b)|~)(\S*)?/;
const FORK_BOMB = /:\(\)\s*\{\s*:\|:&\s*\}\s*;/;
const PIPE_REMOTE_SCRIPT_TO_SHELL = /\b(curl|wget)\b.*\|\s*(sudo\s+)?(ba)?sh\b/i;

// Catches `.env` but not `.env.example` — the `.env` file holds the real ANTHROPIC_API_KEY; the
// example is a safe template. `(?!\.)` lets `.env.example` through while blocking `.env`, `.env `,
// `.env"`, and `.env` at end-of-string.
const READS_ENV_FILE = /\.env(?!\.)/;

// Path traversal: `..` as a directory component (preceded by start/slash/space/quote, followed by
// slash/space/quote/end). Catches `cat ../.env`, `cat ../../src/loop/systemPrompt.ts`, `cd ..`,
// etc. — the agent's cwd is the workspace, so `..` always escapes it. Deliberately narrow: `...`
// and `--` don't match because `..` must be bounded on both sides.
const PATH_TRAVERSAL = /(?:^|[\/\s"'`])\.\.(?:[\/\s"'`]|$)/;

// Naive split on shell statement separators — not a real parser, just enough to stop the rm+escape
// check below from matching across unrelated sub-commands (e.g. an innocuous `rm -rf coverage`
// getting flagged because a *different* sub-command later in the same compound line happens to
// contain ` /some/absolute/path`, observed live: `rm -rf coverage; curl -o /dev/null ...`).
const STATEMENT_SEPARATORS = /&&|\|\||;|\||&|\n/;

function isDestructive(command: string): string | undefined {
  const statements = command.split(STATEMENT_SEPARATORS);
  if (statements.some((statement) => RECURSIVE_FORCE_RM.test(statement) && ESCAPES_WORKSPACE.test(statement))) {
    return "recursive/force delete targeting a path outside the workspace";
  }
  if (/\bmkfs\b/i.test(command)) return "filesystem-format command";
  if (/\bdd\b.*\bof=\/dev\//i.test(command)) return "raw disk write";
  if (FORK_BOMB.test(command)) return "fork bomb";
  if (PIPE_REMOTE_SCRIPT_TO_SHELL.test(command)) return "piping a remote script straight into a shell";
  if (/\bsudo\b/i.test(command)) return "privilege escalation";
  if (READS_ENV_FILE.test(command)) return "reading a .env file (secrets)";
  if (PATH_TRAVERSAL.test(command)) return "path traversal outside the workspace";
  return undefined;
}

// `path.relative`/`path.resolve` are pure string operations (no filesystem access), so this is
// exactly `fileTools.ts`'s `resolveWithinRoot` containment check, reused here for run_command
// instead of a single path argument.
function escapesRoot(root: string, target: string): boolean {
  const expanded = target === "~" || target.startsWith("~/") ? target.replace(/^~/, homedir()) : target;
  if (!isAbsolute(expanded)) return false; // a relative target can't escape without literal ".." (PATH_TRAVERSAL already covers that)
  const rel = relative(root, resolve(expanded));
  return rel.startsWith("..") || isAbsolute(rel);
}

function unquote(token: string): string {
  if (token.length >= 2 && ((token[0] === '"' && token.at(-1) === '"') || (token[0] === "'" && token.at(-1) === "'"))) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * run_command's own description tells the model not to use absolute paths to reach outside the
 * workspace, but (unlike every other tool, which resolves a single path argument through
 * `resolveWithinRoot`) nothing enforced that — confirmed live: a run with no local TypeScript
 * compiler reached for the *host* Rocket project's own `node_modules/.bin/tsc` by absolute path,
 * and a separate run `cd /tmp && npm i ...`'d into unaudited scratch space on the real machine.
 * Deliberately narrow — only the `cd` target and each statement's own invoked command are
 * checked, not every absolute-looking token — so legitimate patterns like `curl -o /dev/null` or
 * a URL embedded in a larger argument aren't false-flagged.
 */
function escapesWorkspaceViaAbsolutePath(command: string, workspaceRoot: string): string | undefined {
  for (const statement of command.split(STATEMENT_SEPARATORS)) {
    const words = statement.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const first = unquote(words[0] ?? "");

    if (first === "cd" && words[1]) {
      const target = unquote(words[1]);
      if ((target.startsWith("/") || target.startsWith("~")) && escapesRoot(workspaceRoot, target)) {
        return `cd to an absolute path outside the workspace: ${target}`;
      }
      continue;
    }

    if ((first.startsWith("/") || first.startsWith("~")) && escapesRoot(workspaceRoot, first)) {
      return `running a command by absolute path outside the workspace: ${first}`;
    }
  }
  return undefined;
}

export function makeToolCallPolicy(workspaceRoot: string): ToolCallPolicy {
  return {
    evaluate(toolName, input) {
      if (toolName !== "run_command") return { allowed: true };
      const command =
        typeof input === "object" && input !== null && "command" in input
          ? String((input as { command: unknown }).command)
          : "";

      const destructive = isDestructive(command);
      if (destructive) {
        return { allowed: false, reason: `Command matches a banned destructive pattern: ${destructive}` };
      }
      const escape = escapesWorkspaceViaAbsolutePath(command, workspaceRoot);
      if (escape) {
        return { allowed: false, reason: `Command escapes the workspace: ${escape}` };
      }
      return { allowed: true };
    },
  };
}
