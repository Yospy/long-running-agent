import Anthropic from "@anthropic-ai/sdk";
import { AgentError } from "../errors/taxonomy.js";

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: readonly string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/**
 * "opaque" round-trips provider-specific blocks (thinking, redacted_thinking, ...)
 * we don't interpret. Dropping them on replay can break tool-use ordering/signature
 * validation on the provider side, so the harness must carry them through unread.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  | { type: "opaque"; providerType: string; raw: unknown };

export interface ModelMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** Generic, provider-agnostic live-update events for terminal rendering. Not the full response —
 * the authoritative result is still the GenerateResult returned once generation finishes. */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use_start"; name: string };

export interface GenerateParams {
  systemPrompt: string;
  tools: ToolDefinition[];
  messages: ModelMessage[];
  maxTokens?: number;
  /** When set, constrains the response to this JSON schema (Anthropic structured outputs). */
  responseFormat?: JsonSchema;
  /** Optional live-update hook for terminal rendering; omitting it changes nothing about the result. */
  onStreamEvent?: ((event: StreamEvent) => void) | undefined;
  /** Defaults to true (the main planning loop benefits from it). Set false for narrow, mechanical
   * calls (intake, completion check, compaction) — adaptive thinking has no fixed budget and its
   * output counts against the same maxTokens ceiling as the final answer, so on a call with a
   * small maxTokens a bout of thinking can starve the actual output. Observed live: a completion
   * check for a single-file task truncated mid-JSON at 2048 tokens for exactly this reason. These
   * calls are simple, bounded judgment calls that don't need extended reasoning in the first
   * place, so disabling it removes the risk instead of just making it less likely. */
  thinking?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "other";

export interface GenerateUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface GenerateResult {
  content: ContentBlock[];
  toolCalls: ToolCall[];
  usage: GenerateUsage;
  stopReason: StopReason;
}

export interface ModelClient {
  generate(params: GenerateParams): Promise<GenerateResult>;
}

// 5 attempts / linear backoff (2s, 4s, 6s, 8s = 20s of waiting) — tuned against a live
// `overloaded_error` observed lasting ~23s across 3 consecutive attempts during verification.
const DEFAULT_GENERATE_MAX_ATTEMPTS = 5;
const DEFAULT_GENERATE_RETRY_DELAY_MS = 2_000;

export interface GenerateRetryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

/**
 * Transient failures (rate limits, overloads, 5xx) are marked recoverable by a ModelClient
 * implementation, but the underlying SDK's own automatic retry doesn't reliably cover errors
 * that arrive in-band mid-stream (the request already returned 200 before the error frame shows
 * up) — every LLM call site retries through this wrapper instead of the raw interface method, so
 * a live-once-in-a-while transient failure doesn't surface as a full run failure. Provider-
 * agnostic: works against the interface only, no Anthropic types involved.
 */
export async function generateWithRetry(
  client: ModelClient,
  params: GenerateParams,
  options: GenerateRetryOptions = {},
): Promise<GenerateResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_GENERATE_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_GENERATE_RETRY_DELAY_MS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await client.generate(params);
    } catch (cause) {
      const recoverable = cause instanceof AgentError && cause.recoverable;
      if (!recoverable || attempt === maxAttempts) throw cause;
      await delay(retryDelayMs * attempt);
    }
  }
  throw new AgentError({ kind: "model", message: "generateWithRetry exhausted attempts", recoverable: false });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicClientOptions {
  apiKey: string;
  model?: string;
  effort?: EffortLevel;
  timeoutMs?: number;
}

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_EFFORT: EffortLevel = "medium";
// Bounds a hung request well below what would silently stall a whole run or subagent.
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class AnthropicClient implements ModelClient {
  private readonly sdk: Anthropic;
  private readonly model: string;
  private readonly effort: EffortLevel;

  constructor(options: AnthropicClientOptions) {
    this.sdk = new Anthropic({ apiKey: options.apiKey, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    this.model = options.model ?? DEFAULT_MODEL;
    this.effort = options.effort ?? DEFAULT_EFFORT;
  }

  /** The resolved model/effort actually in effect (defaults included) — lets a caller (the run
   * manifest) record true configuration without duplicating this class's own default-resolution
   * logic a second time. */
  getConfig(): { model: string; effort: EffortLevel } {
    return { model: this.model, effort: this.effort };
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    const request = buildRequest(params, this.model, this.effort);

    let response: Anthropic.Message;
    try {
      const stream = this.sdk.messages.stream(request);
      if (params.onStreamEvent) {
        const onStreamEvent = params.onStreamEvent;
        stream.on("text", (delta) => onStreamEvent({ type: "text_delta", text: delta }));
        stream.on("thinking", (delta) => onStreamEvent({ type: "thinking_delta", text: delta }));
        stream.on("streamEvent", (event) => {
          if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
            onStreamEvent({ type: "tool_use_start", name: event.content_block.name });
          }
        });
      }
      response = await stream.finalMessage();
    } catch (cause) {
      throw toAgentError(cause);
    }

    return fromAnthropicResponse(response);
  }
}

/** Pure request construction, split out from generate() so the thinking/output_config/tools gating
 * logic is directly unit-testable without touching the SDK or the network. */
export function buildRequest(params: GenerateParams, model: string, effort: EffortLevel): Anthropic.MessageStreamParams {
  const outputConfig: Anthropic.MessageCreateParamsNonStreaming["output_config"] = params.responseFormat
    ? { effort, format: { type: "json_schema", schema: params.responseFormat } }
    : { effort };

  const request: Anthropic.MessageStreamParams = {
    model,
    max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: [
      {
        type: "text",
        text: params.systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    // "summarized" so thinking text is populated for live rendering — Anthropic never returns
    // the raw chain of thought regardless of this setting, only a summary or nothing at all.
    ...(params.thinking !== false ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
    output_config: outputConfig,
    messages: params.messages.map(toAnthropicMessage),
  };
  if (params.tools.length > 0) {
    request.tools = params.tools.map(toAnthropicTool);
  }
  return request;
}

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { ...tool.inputSchema, required: tool.inputSchema.required ? [...tool.inputSchema.required] : null },
  };
}

function toAnthropicMessage(message: ModelMessage): Anthropic.MessageParam {
  return {
    role: message.role,
    content: message.content.map(toAnthropicContentBlock),
  };
}

function toAnthropicContentBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError ?? false,
      };
    case "opaque":
      return block.raw as Anthropic.ContentBlockParam;
  }
}

function fromAnthropicResponse(response: Anthropic.Message): GenerateResult {
  const content: ContentBlock[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    } else {
      content.push({ type: "opaque", providerType: block.type, raw: block });
    }
  }

  return {
    content,
    toolCalls,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
    stopReason: toStopReason(response.stop_reason),
  };
}

function toStopReason(reason: Anthropic.Message["stop_reason"]): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

// Errors that arrive as an in-band SSE `event: error` (the stream already connected with a 200
// before the server signals it) get built by the SDK as a bare APIError with status forced to
// undefined — status alone is not a reliable recoverability signal for a streaming client.
// error.type survives either way, so classify on that first.
const RECOVERABLE_ERROR_TYPES = new Set(["rate_limit_error", "overloaded_error", "api_error"]);

function toAgentError(cause: unknown): AgentError {
  if (cause instanceof Anthropic.APIConnectionError) {
    return new AgentError({
      kind: "model",
      message: "Model API connection failed",
      recoverable: true,
      cause,
    });
  }
  if (cause instanceof Anthropic.APIUserAbortError) {
    // The only abort source in this codebase is our own client timeoutMs firing mid-stream —
    // nothing here ever passes an AbortSignal itself. That's exactly the "hung request" case
    // generateWithRetry exists to absorb, not a fatal error.
    return new AgentError({
      kind: "model",
      message: "Model request aborted (timed out)",
      recoverable: true,
      cause,
    });
  }
  if (cause instanceof Anthropic.APIError) {
    const status = typeof cause.status === "number" ? cause.status : undefined;
    const type = cause.type ?? undefined;
    const recoverable = (status !== undefined && status >= 500) || status === 429 || (type !== undefined && RECOVERABLE_ERROR_TYPES.has(type));
    return new AgentError({
      kind: "model",
      message: `Model API error${type ? ` (${type})` : ""}: ${cause.message}`,
      recoverable,
      cause,
      details: status === undefined && type === undefined ? undefined : { status, type },
    });
  }
  return new AgentError({
    kind: "model",
    message: "Unexpected model client failure",
    recoverable: false,
    cause,
  });
}
