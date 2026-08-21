import { createProxy } from "@vercel/geistdocs/proxy";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { config as geistdocsConfig } from "@/lib/geistdocs/config";
import { removeProxyMarkdownCanonical } from "@/lib/geistdocs/markdown-canonical";
import { markdownRoutes, supportsMarkdownNegotiation } from "@/lib/geistdocs/markdown-routes";
import { trackMdRequest } from "@/lib/geistdocs/md-tracking";
import { appendVaryAccept } from "@/lib/geistdocs/vary";

const geistdocsProxy = createProxy({
  config: geistdocsConfig,
  markdownRoutes,
  trackMarkdownRequest: trackMdRequest,
  before: ({ request }) => (request.nextUrl.pathname === "/nights" ? NextResponse.next() : null),
});

const proxy = async (request: NextRequest, context: NextFetchEvent) => {
  const response = removeProxyMarkdownCanonical(await geistdocsProxy(request, context));
  return supportsMarkdownNegotiation(request.nextUrl.pathname)
    ? appendVaryAccept(response)
    : response;
};

export const config = {
  // These routes need the locale rewrite even though the general matcher ignores static extensions.
  matcher: [
    "/llms.txt",
    "/llms-full.txt",
    "/rss.xml",
    "/((?!api(?:/|$)|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|eve\\.tgz$|.*\\.(?!mdx?$)[^/]+$).*)",
  ],
};

export default proxy;
