import { createChatRoute } from "@vercel/geistdocs/routes/chat";
import {
  methodNotAllowedResponse,
  normalizeApiErrorResponse,
  optionsResponse,
  parseJsonRequestBody,
} from "@/lib/api/errors";
import {
  analyticsEvents,
  getAskAiContext,
  getDocsSurface,
  getResponseOutcome,
} from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { config } from "@/lib/geistdocs/config";
import { geistdocsSource } from "@/lib/geistdocs/source";

export const maxDuration = 800;

const chatRoute = createChatRoute({
  config,
  sources: [geistdocsSource],
});

export const POST = async (request: Request) => {
  const parsed = await parseJsonRequestBody(request.clone(), {
    code: "invalid_chat_request",
    resolution: "Send AI SDK UI messages using the request schema in /openapi.json.",
  });
  if (!parsed.ok) return parsed.response;

  const response = await chatRoute.POST(request);
  const body = parsed.body;

  if (typeof body === "object" && body !== null && "messages" in body) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userTurns = messages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "user",
    ).length;
    const currentRoute = "currentRoute" in body ? body.currentRoute : undefined;
    const hasPageContext = "pageContext" in body && Boolean(body.pageContext);

    trackServerEvent(request, analyticsEvents.askAiSubmitted, {
      context: getAskAiContext(currentRoute, hasPageContext),
      outcome: getResponseOutcome(response.status),
      surface: getDocsSurface(currentRoute),
      turn: userTurns > 1 ? "follow_up" : "first",
    });
  }

  return normalizeApiErrorResponse(response, {
    code: response.status === 400 ? "invalid_chat_request" : "chat_failed",
    resolution:
      response.status === 400
        ? "Send AI SDK UI messages using the request schema in /openapi.json."
        : "Retry later or use /api/search for deterministic documentation retrieval.",
  });
};

export const GET = (request: Request) => methodNotAllowedResponse(request, ["POST"]);
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const OPTIONS = () => optionsResponse(["POST"]);
