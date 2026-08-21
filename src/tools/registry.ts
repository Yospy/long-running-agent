import type { z } from "zod";
import type { JsonSchema, ToolDefinition } from "../model/client.js";
import type { ToolCallPolicy } from "./policy.js";
import { AgentError } from "../errors/taxonomy.js";

export interface ToolContext {
  runDir: string;
  jobId: string;
}

export interface Tool<TInput = unknown> {
  definition: ToolDefinition;
  // Input generic left as `any`: dispatch() always parses `unknown` at runtime, and zod's
  // .default()/.optional() fields make a schema's declared Input type diverge from its Output
  // type (TInput) — that divergence isn't meaningful here, only the parsed Output shape is.
  schema: z.ZodType<TInput, z.ZodTypeDef, any>;
  execute: (input: TInput, ctx: ToolContext) => Promise<string>;
  // Overrides DEFAULT_TIMEOUT_MS for this tool. Needed for tools whose own natural ceiling is
  // higher than a normal single tool call's (e.g. dispatch_subagents, which runs full nested
  // agent loops) — see dispatch_subagents' own timeoutMs for why this matters in practice.
  timeoutMs?: number;
}

// Must exceed run_command's own hard-timeout ceiling (60s + 5s SIGKILL grace) — otherwise this
// generic safety net fires first, abandoning the promise without actually killing the child process.
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Zod-validated dispatch with a generic per-call safety-net timeout (defense in depth beyond any
 * tool's own timeout) and an optional policy gate — the one choke point every tool call passes
 * through, so a policy check here applies uniformly across the whole tool surface, not just one
 * tool. A denial is logged identically to any other tool failure (loop/run.ts already logs every
 * tool_call/tool_result, success or error) — nothing extra needed for the audit trail.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(private readonly policy?: ToolCallPolicy) {}

  register(tool: Tool<any>): void {
    this.tools.set(tool.definition.name, tool as Tool);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  async dispatch(name: string, rawInput: unknown, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AgentError({ kind: "validation", message: `Unknown tool: ${name}`, recoverable: true });
    }

    const parsed = tool.schema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AgentError({
        kind: "validation",
        message: `Invalid input for tool ${name}: ${parsed.error.message}`,
        recoverable: true,
      });
    }

    const decision = this.policy?.evaluate(name, parsed.data);
    if (decision && !decision.allowed) {
      throw new AgentError({
        kind: "validation",
        message: `Tool call denied by policy: ${decision.reason ?? "not allowed"}`,
        recoverable: true,
      });
    }

    try {
      return await withTimeout(tool.execute(parsed.data, ctx), tool.timeoutMs ?? DEFAULT_TIMEOUT_MS, name);
    } catch (cause) {
      if (cause instanceof AgentError) throw cause;
      throw new AgentError({
        kind: "execution",
        message: `Tool ${name} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        recoverable: true,
        cause,
      });
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AgentError({ kind: "timeout", message: `Tool ${toolName} exceeded ${ms}ms`, recoverable: true }));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type { JsonSchema };
