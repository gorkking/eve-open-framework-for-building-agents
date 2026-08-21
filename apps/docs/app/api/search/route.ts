import { createSearchRoute } from "@vercel/geistdocs/routes/search";
import { apiErrorResponse, methodNotAllowedResponse, optionsResponse } from "@/lib/api/errors";
import { config } from "@/lib/geistdocs/config";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { integrationSource } from "@/lib/integrations/source";

const searchRoute = createSearchRoute({
  config,
  sources: [geistdocsSource, integrationSource],
});

export const GET = async (request: Request) => {
  try {
    return await searchRoute(request);
  } catch (error) {
    console.error("Documentation search API error:", error);
    return apiErrorResponse({
      code: "search_failed",
      message: "The documentation index could not be searched.",
      resolution: "Retry the request or browse /llms.txt for direct documentation links.",
      status: 500,
    });
  }
};

export const POST = (request: Request) => methodNotAllowedResponse(request, ["GET"]);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
export const OPTIONS = () => optionsResponse(["GET"]);
