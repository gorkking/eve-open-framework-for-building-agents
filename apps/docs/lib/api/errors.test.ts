import { describe, expect, it } from "vitest";
import {
  apiErrorResponse,
  apiRouteNotFoundResponse,
  methodNotAllowedResponse,
  normalizeApiErrorResponse,
  optionsResponse,
  parseJsonRequestBody,
} from "./errors";

describe("API error responses", () => {
  it("returns a stable machine-readable envelope", async () => {
    const response = apiErrorResponse({
      code: "invalid_request",
      message: "The request is invalid.",
      resolution: "Check /openapi.json and try again.",
      status: 400,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "The request is invalid.",
        resolution: "Check /openapi.json and try again.",
      },
    });
  });

  it("describes unsupported methods and advertises the allowed methods", async () => {
    const response = methodNotAllowedResponse(
      new Request("https://eve.dev/api/chat", { method: "GET" }),
      ["POST"],
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "method_not_allowed",
        message: "GET is not supported for /api/chat.",
      },
    });
  });

  it("normalizes upstream JSON errors without changing successful streams", async () => {
    const upstream = Response.json({ error: "messages must be an array" }, { status: 400 });
    const normalized = await normalizeApiErrorResponse(upstream, {
      code: "invalid_chat_request",
      resolution: "Send UI messages using the schema in /openapi.json.",
    });
    const stream = new Response("data: ok", { headers: { "content-type": "text/event-stream" } });

    await expect(normalized.json()).resolves.toEqual({
      error: {
        code: "invalid_chat_request",
        message: "messages must be an array",
        resolution: "Send UI messages using the schema in /openapi.json.",
      },
    });
    await expect(
      normalizeApiErrorResponse(stream, { code: "unused", resolution: "unused" }),
    ).resolves.toBe(stream);
  });

  it("rejects malformed JSON before an API handler processes it", async () => {
    const result = await parseJsonRequestBody(
      new Request("https://eve.dev/api/chat", { method: "POST", body: "{" }),
      {
        code: "invalid_chat_request",
        resolution: "Use the schema in /openapi.json.",
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    await expect(result.response.json()).resolves.toEqual({
      error: {
        code: "invalid_chat_request",
        message: "The request body must contain valid JSON.",
        resolution: "Use the schema in /openapi.json.",
      },
    });
  });

  it("returns a bodyless options response", async () => {
    const response = optionsResponse(["GET"]);

    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("GET, OPTIONS");
    expect(await response.text()).toBe("");
  });

  it("returns structured JSON for unknown API routes", async () => {
    const response = apiRouteNotFoundResponse(new Request("https://eve.dev/api/unknown"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "api_route_not_found",
        message: "No eve.dev API route matches /api/unknown.",
        resolution: "Use an endpoint listed in /openapi.json.",
      },
    });
  });
});
