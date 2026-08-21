import { apiRouteNotFoundResponse } from "@/lib/api/errors";

const notFound = (request: Request) => apiRouteNotFoundResponse(request);

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
