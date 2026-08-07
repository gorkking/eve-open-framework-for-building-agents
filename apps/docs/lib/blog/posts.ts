export const llmCouncilPost = {
  title: "Build an LLM council with eve and Vercel AI Gateway",
  description:
    "Build a four-model council with filesystem-defined eve agents and Vercel AI Gateway.",
  href: "/blog/build-an-llm-council",
  image: "/blog/eve-llm-council-hero.png",
  imageAlt: "Four model responses connected to a council answer and agreement scores",
  diagramImage: "/blog/eve-llm-council.png",
  publishedAt: "2026-08-07",
  publishedLabel: "August 7, 2026",
  readingTime: "4 min read",
  author: {
    name: "Colton Padden",
    avatar: "/blog/authors/colton-padden.jpg",
    bio: "Core eve team member",
    accounts: {
      github: {
        label: "cmpadden",
        href: "https://github.com/cmpadden",
      },
      x: {
        label: "coltonpadden",
        href: "https://x.com/coltonpadden",
      },
      linkedin: {
        label: "colton-padden",
        href: "https://www.linkedin.com/in/colton-padden/",
      },
    },
  },
  tableOfContents: [
    { title: "What an LLM council adds", href: "#what-an-llm-council-adds" },
    { title: "Building the council", href: "#building-the-council" },
    { title: "Route models with AI Gateway", href: "#route-models-with-ai-gateway" },
    {
      title: "Connecting eve to the web application",
      href: "#connecting-eve-to-the-web-application",
    },
    { title: "Additional reading", href: "#additional-reading" },
  ],
} as const;

export const dynamicCapabilitiesPost = {
  title: "Dynamic capabilities for multiplayer agents",
  description:
    "See how one shared eve agent changes models, tools, skills, instructions, and specialists for each participant.",
  href: "/blog/dynamic-capabilities-for-multiplayer-agents",
  image: "/blog/dynamic-capabilities-for-multiplayer-agents-playbooks.png",
  imageAlt:
    "One shared eve agent resolving different models, tools, skills, instructions, and specialists at runtime",
  publishedAt: "2026-08-10",
  publishedLabel: "August 10, 2026",
  readingTime: "7 min read",
  author: llmCouncilPost.author,
  tableOfContents: [
    { title: "A single agent", href: "#a-single-agent" },
    {
      title: "Recognize who's participating",
      href: "#recognize-whos-participating",
    },
    {
      title: "Participant-specific model routing",
      href: "#participant-specific-model-routing",
    },
    {
      title: "Generate tools from each participant's access",
      href: "#generate-tools-from-each-participants-access",
    },
    {
      title: "Personal, team, and channel skills",
      href: "#personal-team-and-channel-skills",
    },
    {
      title: "Add instructions for the person speaking",
      href: "#add-instructions-for-the-person-speaking",
    },
    {
      title: "Expose specialists only when they apply",
      href: "#expose-specialists-only-when-they-apply",
    },
    {
      title: "Share history without sharing every capability",
      href: "#share-history-without-sharing-every-capability",
    },
  ],
} as const;

export type BlogPost = typeof llmCouncilPost | typeof dynamicCapabilitiesPost;
