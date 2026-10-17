import type { MetadataRoute } from "next";

// Explicitly allow the major AI crawlers so Tidegap shows up when an
// assistant searches for "carbon-aware MCP scheduler" or similar. The
// site has no user-private data; the only thing worth blocking is the
// /api/ surface (which is rate-limited and read-only but isn't useful
// to index).
const AI_BOTS = [
  "GPTBot",            // OpenAI training crawler
  "ChatGPT-User",      // OpenAI in-conversation browse
  "OAI-SearchBot",     // OpenAI search crawler
  "ClaudeBot",         // Anthropic crawler (training)
  "Claude-Web",        // Anthropic search/browse
  "PerplexityBot",     // Perplexity
  "Perplexity-User",   // Perplexity in-conversation
  "Google-Extended",   // Gemini / Vertex training opt-in
  "Applebot-Extended", // Apple Intelligence training
  "CCBot",             // Common Crawl (feeds many models)
  "anthropic-ai",      // legacy Anthropic UA string
  "cohere-ai",         // Cohere
  "FriendlyCrawler",   // mistral.ai / other
  "Diffbot",           // grounded search products
  "Bytespider",        // ByteDance / Doubao
  "Amazonbot",         // Amazon search products
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/api/"] },
      ...AI_BOTS.map((ua) => ({ userAgent: ua, allow: "/" })),
    ],
    sitemap: "https://www.tidegap.com/sitemap.xml",
  };
}
