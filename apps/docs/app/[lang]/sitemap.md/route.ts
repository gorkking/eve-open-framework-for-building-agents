import { createSitemapMarkdownRoute } from "@vercel/geistdocs/routes/sitemap";
import { config } from "@/lib/geistdocs/config";
import { resolveDocsPageTitle } from "@/lib/geistdocs/page-title";
import { transformSitemapMarkdown } from "@/lib/geistdocs/sitemap-transform";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { integrationSource } from "@/lib/integrations/source";
import { templateManifest } from "@/lib/templates/manifest";
import { trustPages } from "@/lib/trust/pages";

export const revalidate = false;
export const dynamic = "error";

const sitemapRoute = createSitemapMarkdownRoute({
  config,
  sources: [{ source: geistdocsSource }, { source: integrationSource }],
  transform: (markdown, { lang }) =>
    transformSitemapMarkdown(markdown, {
      resolveTitle: (title, url) =>
        resolveDocsPageTitle({
          pageTitle: title,
          pageUrl: url,
          tree: geistdocsSource.source.getPageTree(lang),
        }) ?? title,
      resources: [
        ...trustPages.map((page) => ({
          description: page.description,
          href: `/${page.slug}`,
          title: page.title,
          type: "Trust",
        })),
        {
          description: "Machine-readable contract for the eve.dev documentation helper API.",
          href: "/openapi.json",
          title: "eve.dev OpenAPI specification",
          type: "API specification",
        },
        {
          description: "Operating guidance and authoritative discovery links for agents.",
          href: "/agents.md",
          title: "eve agent instructions",
          type: "Agent guidance",
        },
        {
          description: "Curated index for choosing the smallest relevant eve documentation set.",
          href: "/llms.txt",
          title: "eve documentation index for LLMs",
          type: "Agent guidance",
        },
      ],
      templates: templateManifest,
    }),
});

export const GET = sitemapRoute.GET;
export const generateStaticParams = sitemapRoute.generateStaticParams;
