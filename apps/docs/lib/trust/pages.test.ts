import { describe, expect, it } from "vitest";
import { getTrustPage, trustPageMarkdown, trustPagePlainText, trustPages } from "./pages";

describe("trust pages", () => {
  it("publishes one substantive page for every advertised trust route", () => {
    expect(trustPages.map((page) => page.slug)).toEqual(["about", "contact", "privacy"]);
    expect(new Set(trustPages.map((page) => page.slug)).size).toBe(trustPages.length);

    for (const page of trustPages) {
      expect(trustPagePlainText(page).length).toBeGreaterThan(500);
      expect(page.sections.length).toBeGreaterThan(0);
    }
  });

  it("renders self-contained Markdown from the same source as HTML", () => {
    const contact = getTrustPage("contact");
    expect(contact).toBeDefined();
    if (!contact) return;

    const markdown = trustPageMarkdown(contact);
    expect(markdown).toMatch(/^# Contact the eve project/);
    expect(markdown).toContain("## Security reports");
    expect(markdown).toContain("mailto:responsible.disclosure@vercel.com");
  });

  it("does not invent an unknown trust page", () => {
    expect(getTrustPage("terms")).toBeUndefined();
  });
});
