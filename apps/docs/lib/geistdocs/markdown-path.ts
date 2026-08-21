export const getMarkdownRequestedPath = ({ slug }: { slug: string[] }): string =>
  slug[0] === "integrations" ? `/${slug.join("/")}` : ["/docs", ...slug].join("/");

export const markdownNotFoundOptions = {
  getRequestedPath: getMarkdownRequestedPath,
  status: 404,
} as const;
