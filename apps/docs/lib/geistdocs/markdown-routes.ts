import type { GeistdocsMarkdownRoute } from "@vercel/geistdocs/proxy";
import { supportedLanguages } from "./languages";

export const markdownRoutes: GeistdocsMarkdownRoute[] = [
  { from: "/docs/*path", to: "/[lang]/llms.mdx/*path" },
  { from: "/integrations/*path", to: "/[lang]/llms.mdx/integrations/*path" },
  { from: "/about", to: "/[lang]/trust-markdown/about" },
  { from: "/contact", to: "/[lang]/trust-markdown/contact" },
  { from: "/privacy", to: "/[lang]/trust-markdown/privacy" },
];

const MARKDOWN_EXTENSION_PATTERN = /\.mdx?$/;

export const supportsMarkdownNegotiation = (requestedPathname: string): boolean => {
  const segments = requestedPathname.split("/").filter(Boolean);
  if (segments[0] && supportedLanguages.includes(segments[0])) segments.shift();
  const pathname = `/${segments.join("/")}`.replace(MARKDOWN_EXTENSION_PATTERN, "") || "/";

  return markdownRoutes.some(({ from }) => {
    if (!from.endsWith("/*path")) return pathname === from;
    const base = from.slice(0, -"/*path".length);
    return pathname === base || pathname.startsWith(`${base}/`);
  });
};
