import type { Metadata } from "next";
import { canonicalAlternates, canonicalRoutes } from "@/lib/geistdocs/canonical";
import { pageTitleMetadata, siteTitle } from "@/lib/geistdocs/metadata-title";
import { staticOgImage } from "@/lib/geistdocs/og";
import { ArchitectureDiagram } from "./architecture";
import { CTA } from "./cta";
import { FeatureGrid } from "./feature-grid";
import { FileTree } from "./file-tree";
import { HeroAudience } from "./hero-audience";
import { NextjsInterop } from "./nextjs-interop";

const tagline = "Like Next.js for agents. Build durable agents with one folder.";
const titleMetadata = pageTitleMetadata(siteTitle);

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": "https://eve.dev/#software",
      name: "eve",
      url: "https://eve.dev/",
      description: "A filesystem-first framework for durable backend AI agents that run anywhere.",
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "AI agent framework",
      operatingSystem: "Any",
      isAccessibleForFree: true,
      license: "https://github.com/vercel/eve/blob/main/LICENSE",
      downloadUrl: "https://www.npmjs.com/package/eve",
      softwareHelp: "https://eve.dev/docs/getting-started",
      creator: {
        "@id": "https://vercel.com/#organization",
      },
      sameAs: ["https://github.com/vercel/eve", "https://www.npmjs.com/package/eve"],
    },
    {
      "@type": "Organization",
      "@id": "https://vercel.com/#organization",
      name: "Vercel",
      url: "https://vercel.com/",
      sameAs: ["https://github.com/vercel"],
    },
    {
      "@type": "WebSite",
      "@id": "https://eve.dev/#website",
      name: "eve",
      url: "https://eve.dev/",
      description:
        "Documentation for eve, a filesystem-first framework for durable backend AI agents.",
      about: {
        "@id": "https://eve.dev/#software",
      },
      publisher: {
        "@id": "https://vercel.com/#organization",
      },
    },
  ],
};

export const homeMetadata: Metadata = {
  ...titleMetadata,
  description: tagline,
  alternates: canonicalAlternates(canonicalRoutes.home),
  openGraph: {
    ...titleMetadata.openGraph,
    description: tagline,
    images: [staticOgImage],
  },
  twitter: {
    ...titleMetadata.twitter,
    card: "summary_large_image",
    description: tagline,
    images: [staticOgImage],
  },
};

export const HomeContent = () => (
  <>
    <script
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
      }}
      id="home-structured-data"
      type="application/ld+json"
    />
    <div className="mx-auto w-full max-w-[1080px] pb-32">
      <section className="relative isolate flex min-h-[80vh] flex-col items-center justify-center gap-y-5 px-4 pt-24 pb-12 text-center sm:px-12 sm:pb-16 sm:pt-42">
        <HeroAudience tagline={tagline} />
      </section>
      <FileTree />
      <NextjsInterop />
      <ArchitectureDiagram />
      <FeatureGrid />
      <CTA />
    </div>
  </>
);
