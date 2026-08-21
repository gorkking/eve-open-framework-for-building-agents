const EVE_ORIGIN = "https://eve.dev";
const EVE_DESCRIPTION =
  "A filesystem-first, Apache-2.0 framework for building durable backend AI agents that run on Vercel or self-hosted infrastructure.";

export const createHomeStructuredData = () => ({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${EVE_ORIGIN}/#website`,
      name: "eve Documentation",
      alternateName: "eve agent framework documentation",
      description: EVE_DESCRIPTION,
      inLanguage: "en",
      url: EVE_ORIGIN,
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${EVE_ORIGIN}/#software`,
      name: "eve",
      alternateName: "eve agent framework",
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "AI agent framework",
      description: EVE_DESCRIPTION,
      downloadUrl: "https://www.npmjs.com/package/eve",
      isAccessibleForFree: true,
      license: "https://www.apache.org/licenses/LICENSE-2.0.html",
      operatingSystem: "Cross-platform",
      sameAs: ["https://github.com/vercel/eve", "https://www.npmjs.com/package/eve"],
      url: EVE_ORIGIN,
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": `${EVE_ORIGIN}/#source`,
      codeRepository: "https://github.com/vercel/eve",
      description: EVE_DESCRIPTION,
      license: "https://www.apache.org/licenses/LICENSE-2.0.html",
      name: "eve source code",
      programmingLanguage: ["TypeScript", "Markdown"],
      runtimePlatform: "Node.js",
      targetProduct: { "@id": `${EVE_ORIGIN}/#software` },
      url: "https://github.com/vercel/eve",
    },
  ],
});
