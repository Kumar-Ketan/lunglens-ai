import { APICallError } from "ai";
import { describe, expect, it } from "vitest";

import { mapAiError } from "./xray-analysis.server";

function makeApiError(statusCode: number, body?: unknown) {
  const base = {
    message: `HTTP ${statusCode}`,
    url: "https://ai.gateway.lovable.dev/v1/responses",
    requestBodyValues: {},
    statusCode,
  };
  return new APICallError(body ? { ...base, responseBody: JSON.stringify(body) } : base);
}

describe("mapAiError", () => {
  it("unwraps a 402 Payment Required stream error and explains how to resume", () => {
    const streamErr = makeApiError(402, { error: { message: "Not enough credits" } });
    const mapped = mapAiError(new Error("No output generated. Check the stream for errors."), streamErr);
    expect(mapped.status).toBe(402);
    expect(mapped.message).toContain("Not enough credits");
    expect(mapped.message).toContain("Try again");
  });

  it("falls back to a clear credits message on 402 with empty body", () => {
    const mapped = mapAiError(new Error("No output"), makeApiError(402));
    expect(mapped.status).toBe(402);
    expect(mapped.message).toContain("credits");
  });

  it("preserves 403 gateway denial reason", () => {
    const mapped = mapAiError(new Error("No output"), makeApiError(403, { message: "Model disabled" }));
    expect(mapped.status).toBe(403);
    expect(mapped.message).toBe("Model disabled");
  });

  it("returns a retry-later message for 429 rate limits", () => {
    const mapped = mapAiError(new Error("No output"), makeApiError(429));
    expect(mapped.status).toBe(429);
    expect(mapped.message).toContain("busy");
  });
});