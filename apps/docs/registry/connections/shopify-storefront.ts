import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://your-store.myshopify.com/api/mcp",
  description: "Shopify storefront: Help customers search, ask, and buy in natural language.",
});
