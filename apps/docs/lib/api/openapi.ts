const errorResponse = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ErrorResponse" },
    },
  },
});

export const openApiDocument = {
  openapi: "3.1.1",
  info: {
    title: "eve.dev Documentation API",
    version: "1.0.0",
    description:
      "Search the public eve documentation or ask the eve documentation assistant. This contract describes eve.dev helper endpoints, not the runtime API exposed by an eve application.",
    license: {
      name: "Apache-2.0",
      identifier: "Apache-2.0",
    },
  },
  servers: [{ url: "https://eve.dev", description: "Production documentation site" }],
  externalDocs: {
    description: "eve documentation index",
    url: "https://eve.dev/llms.txt",
  },
  tags: [
    {
      name: "Documentation",
      description: "Read-only discovery and assistance for public eve documentation.",
    },
  ],
  paths: {
    "/api/search": {
      get: {
        operationId: "searchEveDocumentation",
        summary: "Search eve documentation",
        description:
          "Returns ranked passages and pages from the public eve documentation and integration directory. An omitted or empty query returns an empty array.",
        tags: ["Documentation"],
        security: [],
        parameters: [
          {
            name: "query",
            in: "query",
            description: "Text to search for. Use concrete eve API names or task terms.",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "locale",
            in: "query",
            description: "Documentation locale. eve.dev currently publishes English content.",
            required: false,
            schema: { type: "string", enum: ["en"], default: "en" },
          },
          {
            name: "tag",
            in: "query",
            description: "Comma-separated search tags when the index defines them.",
            required: false,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Ranked documentation results.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/SearchResult" },
                },
              },
            },
          },
          "405": errorResponse("The HTTP method is not supported."),
          "500": errorResponse("The documentation index could not be searched."),
        },
      },
    },
    "/api/chat": {
      post: {
        operationId: "askEveDocumentation",
        summary: "Ask the eve documentation assistant",
        description:
          "Streams an AI SDK UI message response grounded in public eve documentation. Use the search operation when a deterministic ranked result is sufficient.",
        tags: ["Documentation"],
        security: [],
        requestBody: {
          required: true,
          description: "The AI SDK UI message conversation and optional current-page context.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ChatRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "An AI SDK UI message stream encoded as server-sent events.",
            headers: {
              "x-vercel-ai-ui-message-stream": {
                description: "Identifies the AI SDK UI message stream protocol version.",
                schema: { type: "string" },
              },
            },
            content: {
              "text/event-stream": {
                schema: { type: "string", description: "AI SDK UI message stream events." },
              },
            },
          },
          "400": errorResponse("The chat request does not match the required message shape."),
          "405": errorResponse("The HTTP method is not supported."),
          "500": errorResponse("The documentation assistant could not complete the request."),
        },
      },
    },
  },
  components: {
    schemas: {
      ErrorResponse: {
        type: "object",
        additionalProperties: false,
        required: ["error"],
        properties: {
          error: {
            type: "object",
            additionalProperties: false,
            required: ["code", "message", "resolution"],
            properties: {
              code: { type: "string", description: "Stable machine-readable error code." },
              message: { type: "string", description: "Human-readable failure description." },
              resolution: { type: "string", description: "Concrete next action for the caller." },
            },
          },
        },
      },
      HighlightedText: {
        type: "object",
        additionalProperties: false,
        required: ["type", "content"],
        properties: {
          type: { type: "string", const: "text" },
          content: { type: "string" },
          styles: {
            type: "object",
            additionalProperties: false,
            properties: { highlight: { type: "boolean" } },
          },
        },
      },
      SearchResult: {
        type: "object",
        additionalProperties: false,
        required: ["id", "url", "type", "content"],
        properties: {
          id: { type: "string", description: "Stable search-index result identifier." },
          url: { type: "string", description: "Site-relative canonical documentation URL." },
          type: { type: "string", enum: ["page", "heading", "text"] },
          content: { type: "string", description: "Matching title, heading, or passage." },
          breadcrumbs: { type: "array", items: { type: "string" } },
          contentWithHighlights: {
            type: "array",
            deprecated: true,
            description: "Legacy segmented highlights. Prefer content.",
            items: { $ref: "#/components/schemas/HighlightedText" },
          },
        },
      },
      UiMessagePart: {
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string", description: "AI SDK UI message part discriminator." },
          text: { type: "string", description: "Text for a text message part." },
        },
        additionalProperties: true,
      },
      UiMessage: {
        type: "object",
        required: ["id", "role", "parts"],
        properties: {
          id: { type: "string" },
          role: { type: "string", enum: ["system", "user", "assistant"] },
          parts: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/components/schemas/UiMessagePart" },
          },
        },
        additionalProperties: true,
      },
      PageContext: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url", "content"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          content: { type: "string", description: "Markdown for the current documentation page." },
        },
      },
      ChatRequest: {
        type: "object",
        additionalProperties: false,
        required: ["messages"],
        properties: {
          messages: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/components/schemas/UiMessage" },
          },
          currentRoute: {
            type: "string",
            description: "Site-relative route used to focus documentation retrieval.",
          },
          pageContext: { $ref: "#/components/schemas/PageContext" },
        },
      },
    },
  },
} satisfies Record<string, unknown>;
