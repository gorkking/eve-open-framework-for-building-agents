import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi";

describe("eve.dev OpenAPI document", () => {
  it("describes the deployed documentation endpoints with unique operation IDs", () => {
    expect(openApiDocument.openapi).toBe("3.1.1");
    expect(openApiDocument.info.title).toContain("eve.dev");
    expect(openApiDocument.paths).toHaveProperty("/api/search.get");
    expect(openApiDocument.paths).toHaveProperty("/api/chat.post");

    const operations = Object.values(openApiDocument.paths).flatMap((path) => Object.values(path));
    const operationIds = operations.map((operation) => operation.operationId);

    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operationIds).toEqual(["searchEveDocumentation", "askEveDocumentation"]);
    for (const operation of operations) {
      expect(operation.description.length).toBeGreaterThan(40);
      expect(operation.responses).toBeDefined();
    }
  });

  it("types every parameter, request body, response, and structured error field", () => {
    const search = openApiDocument.paths["/api/search"].get;
    const chat = openApiDocument.paths["/api/chat"].post;
    const error = openApiDocument.components.schemas.ErrorResponse;

    expect(search.parameters.map(({ name }) => name)).toEqual(["query", "locale", "tag"]);
    expect(search.parameters.every((parameter) => parameter.schema.type)).toBe(true);
    expect(chat.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/ChatRequest",
    );
    expect(chat.responses["200"].content["text/event-stream"].schema.type).toBe("string");
    expect(error.properties.error.required).toEqual(["code", "message", "resolution"]);
  });

  it("does not claim that eve.dev is an eve runtime API", () => {
    expect(openApiDocument.info.description).toContain("not the runtime API");
    expect(openApiDocument.paths).not.toHaveProperty("/eve/v1");
  });
});
