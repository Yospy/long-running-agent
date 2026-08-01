export type ErrorKind = "validation" | "timeout" | "execution" | "model" | "budget_exceeded";

export interface AgentErrorOptions {
  kind: ErrorKind;
  message: string;
  recoverable: boolean;
  cause?: unknown;
  details?: Record<string, unknown> | undefined;
}

export class AgentError extends Error {
  readonly kind: ErrorKind;
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown> | undefined;
  readonly occurredAt: string;
  override readonly cause?: unknown;

  constructor(options: AgentErrorOptions) {
    super(options.message);
    this.name = "AgentError";
    this.kind = options.kind;
    this.recoverable = options.recoverable;
    this.details = options.details;
    this.cause = options.cause;
    this.occurredAt = new Date().toISOString();
  }

  /** Safe to feed back into model context: no stack traces, no secrets. */
  toModelText(): string {
    const detail = this.details ? ` (${JSON.stringify(this.details)})` : "";
    return `[error:${this.kind}] ${this.message}${detail}`;
  }

  toLogRecord(): Record<string, unknown> {
    return {
      kind: this.kind,
      message: this.message,
      recoverable: this.recoverable,
      details: this.details,
      occurredAt: this.occurredAt,
    };
  }
}
