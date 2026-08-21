export type TrustPageSlug = "about" | "contact" | "privacy";

interface TrustPageLink {
  description: string;
  href: string;
  label: string;
}

interface TrustPageSection {
  heading: string;
  links?: TrustPageLink[];
  paragraphs: string[];
}

export interface TrustPageData {
  description: string;
  intro: string;
  sections: TrustPageSection[];
  slug: TrustPageSlug;
  title: string;
}

export const trustPages: TrustPageData[] = [
  {
    slug: "about",
    title: "About eve",
    description:
      "Learn what the eve framework is, who maintains it, how it is licensed, and where to verify its source and release status.",
    intro:
      "eve is a filesystem-first framework for durable backend AI agents. You author an agent as a directory containing instructions, tools, skills, connections, channels, subagents, schedules, and other capabilities. eve compiles that directory into a runtime that can run on Vercel or self-hosted infrastructure.",
    sections: [
      {
        heading: "Project and license",
        paragraphs: [
          "Vercel develops eve as an open-source project. The framework is distributed through the npm package named eve, and its source is published in the vercel/eve repository. The code is licensed under Apache License 2.0. The repository is the authoritative place to inspect implementation details, release history, contribution requirements, and reported issues.",
          "eve is currently in beta. Public APIs, documentation, and behavior may change before general availability. The current documentation describes the latest published release; an installed package also includes version-matched documentation under node_modules/eve/docs.",
        ],
        links: [
          {
            label: "eve source repository",
            href: "https://github.com/vercel/eve",
            description: "Source, releases, issues, and contribution history.",
          },
          {
            label: "eve on npm",
            href: "https://www.npmjs.com/package/eve",
            description: "Published package versions and package metadata.",
          },
          {
            label: "Apache License 2.0",
            href: "https://github.com/vercel/eve/blob/main/LICENSE",
            description: "The repository's license text.",
          },
        ],
      },
      {
        heading: "Documentation scope",
        paragraphs: [
          "eve.dev documents the framework and provides a search endpoint and documentation assistant. It is not a shared eve runtime, authorization server, or MCP server. Every deployed eve application owns its runtime URL, enabled channels, authentication policy, data, and operational controls.",
        ],
      },
    ],
  },
  {
    slug: "contact",
    title: "Contact the eve project",
    description:
      "Find the correct public or private channel for eve questions, bug reports, feature requests, contributions, conduct concerns, and security reports.",
    intro:
      "The eve project uses different channels for community questions, reproducible product reports, contributions, and confidential security disclosures. Choose the channel that matches the request so maintainers receive the context they need without exposing sensitive information.",
    sections: [
      {
        heading: "Questions and project discussion",
        paragraphs: [
          "Use GitHub Discussions for help with an eve project, design questions, ideas, and examples you want to share with the community. Search existing discussions first and include the eve version, deployment target, relevant configuration, and the smallest safe reproduction when those details affect the question.",
        ],
        links: [
          {
            label: "GitHub Discussions",
            href: "https://github.com/vercel/eve/discussions",
            description: "Community help, design discussion, and examples.",
          },
        ],
      },
      {
        heading: "Bugs, features, and contributions",
        paragraphs: [
          "Use the repository issue templates for reproducible bugs and feature requests. Do not create a public issue for a suspected vulnerability or include credentials, private prompts, customer data, or access tokens. If you plan to contribute code or documentation, read the contribution guide before opening a pull request; it defines setup, testing, signing, and DCO requirements.",
        ],
        links: [
          {
            label: "Issue templates",
            href: "https://github.com/vercel/eve/issues/new/choose",
            description: "Report a bug or propose a feature.",
          },
          {
            label: "Contribution guide",
            href: "https://github.com/vercel/eve/blob/main/CONTRIBUTING.md",
            description: "Repository setup and pull request requirements.",
          },
          {
            label: "Code of Conduct",
            href: "https://github.com/vercel/eve/blob/main/CODE_OF_CONDUCT.md",
            description: "Community participation and conduct reporting.",
          },
        ],
      },
      {
        heading: "Security reports",
        paragraphs: [
          "Report suspected security vulnerabilities privately to Vercel's responsible disclosure address. Include the affected version, impact, reproduction steps, and any mitigation you have already applied. Do not open a public issue until the report has been reviewed and disclosure is coordinated.",
        ],
        links: [
          {
            label: "responsible.disclosure@vercel.com",
            href: "mailto:responsible.disclosure@vercel.com",
            description: "Private security vulnerability reports.",
          },
          {
            label: "Security policy",
            href: "https://github.com/vercel/eve/blob/main/SECURITY.md",
            description: "The repository's security reporting instructions.",
          },
        ],
      },
    ],
  },
  {
    slug: "privacy",
    title: "Privacy on eve.dev",
    description:
      "Understand which Vercel privacy notice governs eve.dev and what happens when you use site analytics or the Ask AI documentation feature.",
    intro:
      "eve.dev is a Vercel-operated documentation site for the open-source eve framework. Vercel's Privacy Notice governs information processed when you visit this site or interact with its services. The notice explains applicability, collected information, uses, disclosures, retention, international transfers, privacy rights, and contact methods.",
    sections: [
      {
        heading: "Documentation visits and performance data",
        paragraphs: [
          "The site includes Vercel Web Analytics and Speed Insights. Web Analytics records aggregate usage such as page views, routes, referrers, coarse location, browser, device, and operating system information. Vercel documents Web Analytics as cookie-free and designed around anonymized, aggregated data. Speed Insights collects real-user performance measurements such as page loading, responsiveness, and visual stability metrics.",
          "The linked Vercel documentation describes the current data points and controls for those services. The Vercel Privacy Notice remains the controlling statement for Vercel's processing and for requests about privacy rights.",
        ],
        links: [
          {
            label: "Vercel Privacy Notice",
            href: "https://vercel.com/legal/privacy-notice",
            description: "The privacy notice governing Vercel sites and services.",
          },
          {
            label: "Web Analytics privacy and compliance",
            href: "https://vercel.com/docs/analytics/privacy-policy",
            description: "Data collected by Vercel Web Analytics.",
          },
          {
            label: "Speed Insights metrics",
            href: "https://vercel.com/docs/speed-insights/metrics",
            description: "Real-user performance data points.",
          },
        ],
      },
      {
        heading: "Ask AI",
        paragraphs: [
          "When you use Ask AI, the site sends your conversation and any page context you attach to a documentation assistant operated for eve.dev so it can generate a response. Do not submit secrets, access tokens, private source code, confidential prompts, personal data, or other information that does not belong in a support request. You can read the documentation directly without using Ask AI.",
        ],
      },
      {
        heading: "Your deployed eve applications",
        paragraphs: [
          "This page applies to eve.dev, not to applications built with eve. An eve deployer chooses models, tools, channels, storage, authentication, observability, and infrastructure. That deployer is responsible for explaining its own data practices and meeting the privacy, security, and legal requirements that apply to its users and workloads.",
        ],
      },
    ],
  },
];

export const getTrustPage = (slug: string): TrustPageData | undefined =>
  trustPages.find((page) => page.slug === slug);

export const trustPagePlainText = (page: TrustPageData): string =>
  [
    page.title,
    page.description,
    page.intro,
    ...page.sections.flatMap((section) => [
      section.heading,
      ...section.paragraphs,
      ...(section.links ?? []).flatMap((link) => [link.label, link.description]),
    ]),
  ].join(" ");

export const trustPageMarkdown = (page: TrustPageData): string => {
  const sections = page.sections.map((section) => {
    const links = section.links?.map(
      (link) => `- [${link.label}](${link.href}): ${link.description}`,
    );
    return [
      `## ${section.heading}`,
      "",
      ...section.paragraphs,
      ...(links ? ["", ...links] : []),
    ].join("\n\n");
  });

  return [`# ${page.title}`, "", `> ${page.description}`, "", page.intro, "", ...sections].join(
    "\n",
  );
};
