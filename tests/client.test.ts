import { describe, expect, it } from "vitest";
import { buildRequest, type GenerateParams } from "../src/model/client.js";

function baseParams(overrides: Partial<GenerateParams> = {}): GenerateParams {
  return {
    systemPrompt: "test",
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...overrides,
  };
}

describe("buildRequest", () => {
  it("includes adaptive thinking by default (thinking omitted)", () => {
    const request = buildRequest(baseParams(), "claude-opus-5", "medium");
    expect(request.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  // Regression: adaptive thinking has no fixed budget and its output counts against maxTokens, so
  // narrow/mechanical calls (intake, completion check, compaction) explicitly disable it — this
  // must actually omit the key from the request, not just set it to some falsy-but-present value
  // the SDK might still interpret as "thinking enabled".
  it("omits thinking entirely from the request when thinking: false", () => {
    const request = buildRequest(baseParams({ thinking: false }), "claude-opus-5", "medium");
    expect(request).not.toHaveProperty("thinking");
  });

  it("includes response_format via output_config when responseFormat is set", () => {
    const schema = { type: "object", properties: {}, required: [] } as const;
    const request = buildRequest(baseParams({ responseFormat: schema }), "claude-opus-5", "high");
    expect(request.output_config).toEqual({ effort: "high", format: { type: "json_schema", schema } });
  });

  it("omits the format key from output_config when responseFormat is not set", () => {
    const request = buildRequest(baseParams(), "claude-opus-5", "medium");
    expect(request.output_config).toEqual({ effort: "medium" });
  });

  it("omits tools from the request when none are given", () => {
    const request = buildRequest(baseParams({ tools: [] }), "claude-opus-5", "medium");
    expect(request.tools).toBeUndefined();
  });

  it("maps tools onto the request when given", () => {
    const request = buildRequest(
      baseParams({
        tools: [{ name: "read_file", description: "read", inputSchema: { type: "object", properties: {}, required: [] } }],
      }),
      "claude-opus-5",
      "medium",
    );
    expect(request.tools).toHaveLength(1);
    expect(request.tools?.[0]?.name).toBe("read_file");
  });
});
