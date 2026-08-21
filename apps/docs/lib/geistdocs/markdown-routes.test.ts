import { describe, expect, it } from "vitest";
import { markdownRoutes, supportsMarkdownNegotiation } from "./markdown-routes";

const integrationsRoute = markdownRoutes.find(({ from }) => from === "/integrations/*path");

const rewriteIntegration = (path: string): string | undefined => {
  if (!integrationsRoute || typeof integrationsRoute.to !== "string") return;
  return integrationsRoute.to.replace("[lang]", "en").replace("*path", path);
};

describe("markdownRoutes", () => {
  it("maps valid integration Markdown requests to the shared route", () => {
    expect(rewriteIntegration("slack")).toBe("/en/llms.mdx/integrations/slack");
  });

  it("maps missing integrations to the smart Markdown handler", () => {
    expect(rewriteIntegration("slak")).toBe("/en/llms.mdx/integrations/slak");
  });

  it("keeps docs Markdown routing intact", () => {
    expect(markdownRoutes).toContainEqual({
      from: "/docs/*path",
      to: "/[lang]/llms.mdx/*path",
    });
  });

  it("maps trust pages to their shared Markdown source", () => {
    expect(markdownRoutes).toContainEqual({
      from: "/about",
      to: "/[lang]/trust-markdown/about",
    });
    expect(markdownRoutes).toContainEqual({
      from: "/contact",
      to: "/[lang]/trust-markdown/contact",
    });
    expect(markdownRoutes).toContainEqual({
      from: "/privacy",
      to: "/[lang]/trust-markdown/privacy",
    });
  });

  it.each([
    "/docs/getting-started",
    "/docs/getting-started.md",
    "/integrations/slack",
    "/about",
    "/contact.md",
    "/en/privacy",
  ])("recognizes negotiated path %s", (pathname) => {
    expect(supportsMarkdownNegotiation(pathname)).toBe(true);
  });

  it.each(["/", "/templates", "/openapi.json", "/missing"])(
    "does not negotiate unrelated path %s",
    (pathname) => {
      expect(supportsMarkdownNegotiation(pathname)).toBe(false);
    },
  );
});
