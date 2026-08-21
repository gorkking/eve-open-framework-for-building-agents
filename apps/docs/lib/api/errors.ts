export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    resolution: string;
  };
}

interface ApiErrorOptions {
  code: string;
  message: string;
  resolution: string;
  status: number;
  headers?: HeadersInit;
}

export const apiErrorResponse = ({
  code,
  message,
  resolution,
  status,
  headers: initialHeaders,
}: ApiErrorOptions): Response => {
  const headers = new Headers(initialHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");

  return new Response(
    JSON.stringify({ error: { code, message, resolution } } satisfies ApiErrorBody),
    {
      status,
      headers,
    },
  );
};

type ParsedJsonBody = { body: unknown; ok: true } | { ok: false; response: Response };

export const parseJsonRequestBody = async (
  request: Request,
  { code, resolution }: Pick<ApiErrorOptions, "code" | "resolution">,
): Promise<ParsedJsonBody> => {
  try {
    return { body: await request.json(), ok: true };
  } catch {
    return {
      ok: false,
      response: apiErrorResponse({
        code,
        message: "The request body must contain valid JSON.",
        resolution,
        status: 400,
      }),
    };
  }
};

export const methodNotAllowedResponse = (request: Request, allowedMethods: string[]): Response => {
  const allow = [...allowedMethods, "OPTIONS"];
  const { pathname } = new URL(request.url);

  return apiErrorResponse({
    code: "method_not_allowed",
    message: `${request.method} is not supported for ${pathname}.`,
    resolution: `Use ${allowedMethods.join(" or ")} as described in /openapi.json.`,
    status: 405,
    headers: { Allow: allow.join(", ") },
  });
};

export const optionsResponse = (allowedMethods: string[]): Response =>
  new Response(null, {
    status: 204,
    headers: { Allow: [...allowedMethods, "OPTIONS"].join(", ") },
  });

export const apiRouteNotFoundResponse = (request: Request): Response => {
  const { pathname } = new URL(request.url);
  return apiErrorResponse({
    code: "api_route_not_found",
    message: `No eve.dev API route matches ${pathname}.`,
    resolution: "Use an endpoint listed in /openapi.json.",
    status: 404,
  });
};

const readUpstreamMessage = async (response: Response): Promise<string | undefined> => {
  if (!response.headers.get("content-type")?.includes("application/json")) return;

  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== "object" || !("error" in body)) return;
  if (typeof body.error === "string") return body.error;
  if (
    body.error &&
    typeof body.error === "object" &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
};

export const normalizeApiErrorResponse = async (
  response: Response,
  { code, resolution }: Pick<ApiErrorOptions, "code" | "resolution">,
): Promise<Response> => {
  if (response.ok) return response;

  const message =
    (await readUpstreamMessage(response)) ??
    (response.statusText || "The request could not be completed.");
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");

  return apiErrorResponse({ code, message, resolution, status: response.status, headers });
};
