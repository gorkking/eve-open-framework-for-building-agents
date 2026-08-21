import type { Metadata } from "next";
import { canonicalAlternates } from "@/lib/geistdocs/canonical";
import { pageTitleMetadata } from "@/lib/geistdocs/metadata-title";
import { staticOgImage } from "@/lib/geistdocs/og";
import { getTrustPage, type TrustPageSlug } from "@/lib/trust/pages";

export const createTrustPageMetadata = (slug: TrustPageSlug): Metadata => {
  const page = getTrustPage(slug);
  if (!page) throw new Error(`Unknown trust page: ${slug}`);
  const titleMetadata = pageTitleMetadata(page.title);

  return {
    ...titleMetadata,
    description: page.description,
    alternates: canonicalAlternates(`/${page.slug}`, {
      types: { "text/markdown": `/${page.slug}.md` },
    }),
    openGraph: {
      ...titleMetadata.openGraph,
      description: page.description,
      images: [staticOgImage],
      type: "website",
      url: `/${page.slug}`,
    },
    twitter: {
      ...titleMetadata.twitter,
      card: "summary_large_image",
      description: page.description,
      images: [staticOgImage],
    },
  };
};

export const TrustPage = ({ slug }: { slug: TrustPageSlug }) => {
  const page = getTrustPage(slug);
  if (!page) throw new Error(`Unknown trust page: ${slug}`);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-24">
      <header>
        <h1 className="text-heading-40 text-gray-1000 sm:text-heading-48">{page.title}</h1>
        <p className="mt-5 text-balance text-copy-18 text-gray-900">{page.intro}</p>
      </header>
      <div className="mt-12 space-y-12">
        {page.sections.map((section) => {
          const headingId = `${page.slug}-${section.heading}`.toLowerCase().replaceAll(" ", "-");
          return (
            <section key={section.heading} aria-labelledby={headingId}>
              <h2 className="text-heading-24 text-gray-1000" id={headingId}>
                {section.heading}
              </h2>
              <div className="mt-4 space-y-4 text-copy-16 text-gray-900">
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
              {section.links ? (
                <ul className="mt-5 space-y-3">
                  {section.links.map((link) => (
                    <li key={link.href}>
                      <a
                        className="font-medium text-gray-1000 underline decoration-gray-400 underline-offset-4 transition-colors hover:decoration-gray-1000"
                        href={link.href}
                      >
                        {link.label}
                      </a>
                      <span className="text-gray-900"> — {link.description}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>
    </main>
  );
};
