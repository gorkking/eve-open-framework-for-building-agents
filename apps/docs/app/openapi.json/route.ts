import { openApiDocument } from "@/lib/api/openapi";

export const revalidate = false;

export const GET = () =>
  Response.json(openApiDocument, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=3600" },
  });
