export const appendVaryAccept = (response: Response): Response => {
  const tokens = (response.headers.get("Vary") ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  if (!tokens.some((token) => token.toLowerCase() === "accept")) {
    response.headers.set("Vary", [...tokens, "Accept"].join(", "));
  }

  return response;
};
