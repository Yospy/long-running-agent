export type AgentPhase =
  | "intake"
  | "planning"
  | "executing_tool"
  | "compacting"
  | "validating_completion"
  | "error"
  | "done";

const TRANSITIONS: Record<AgentPhase, AgentPhase[]> = {
  intake: ["planning", "error"],
  planning: ["executing_tool", "compacting", "validating_completion", "error"],
  executing_tool: ["planning", "error"],
  compacting: ["planning", "error"],
  validating_completion: ["planning", "done", "error"],
  error: [],
  done: [],
};

/** Throws on an illegal transition — an internal invariant violation, not a runtime/model failure. */
export function assertValidTransition(from: AgentPhase, to: AgentPhase): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal state transition: ${from} -> ${to}`);
  }
}
