import { describe, expect, it } from "vitest";
import { assertValidTransition } from "../src/loop/state.js";

describe("assertValidTransition", () => {
  it("allows the documented happy path", () => {
    expect(() => assertValidTransition("intake", "planning")).not.toThrow();
    expect(() => assertValidTransition("planning", "executing_tool")).not.toThrow();
    expect(() => assertValidTransition("executing_tool", "planning")).not.toThrow();
    expect(() => assertValidTransition("planning", "validating_completion")).not.toThrow();
    expect(() => assertValidTransition("validating_completion", "done")).not.toThrow();
  });

  it("rejects a self-loop that would skip real work", () => {
    expect(() => assertValidTransition("planning", "planning")).toThrow(/Illegal state transition/);
  });

  it("rejects transitions out of terminal states", () => {
    expect(() => assertValidTransition("done", "planning")).toThrow();
    expect(() => assertValidTransition("error", "planning")).toThrow();
  });
});
