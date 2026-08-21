import { isSupportedLanguage, supportedLanguages } from "@/lib/geistdocs/languages";
import { getTrustPage, trustPageMarkdown, trustPages } from "@/lib/trust/pages";

export const revalidate = false;

export const generateStaticParams = () =>
  supportedLanguages.flatMap((lang) => trustPages.map(({ slug }) => ({ lang, slug })));

export const GET = async (
  request: Request,
  context: RouteContext<"/[lang]/trust-markdown/[slug]">,
) => {
  const { lang, slug } = await context.params;
  const page = isSupportedLanguage(lang) ? getTrustPage(slug) : undefined;
  if (!page) {
    return new Response(
      "# Page Not Found\n\nThe requested eve project page does not exist. Browse [/llms.txt](/llms.txt) or [/sitemap.md](/sitemap.md).\n",
      {
        status: 404,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          Vary: "Accept",
          "X-Robots-Tag": "noindex",
        },
      },
    );
  }

  const canonicalUrl = new URL(`/${page.slug}`, request.url).toString();
  return new Response(trustPageMarkdown(page), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Link: `<${canonicalUrl}>; rel="canonical"`,
      Vary: "Accept",
    },
  });
};
