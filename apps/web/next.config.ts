import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Pin the file-tracing root to the workspace root so Next stops warning
  // about multiple lockfiles (the repo has its own pnpm lockfile in the
  // monorepo root; the user may also have a stray ~/package-lock.json).
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  // The dashboard runs read-only on the public grid feeds (with mock fallback).
  // No image domains needed; charts are SVG via recharts.

  // Pretty-URL rewrites for the static-site pages bundled under `public/`.
  // Visitors get /architecture, /docs, /roadmap instead of the .html
  // variants. Filed under "polish #3" in v0.8.x — closes the 404 on
  // the live site that the global test pass found.
  async rewrites() {
    return [
      // /docs is now a real Next.js route.
      // /architecture stays as a static .html page in public/.
      // /roadmap was removed — that content is now private planning, kept
      // in ROADMAP.md outside git rather than published.
      { source: "/architecture", destination: "/architecture.html" },
    ];
  },

  // Baseline security headers for every response — including the static
  // `public/` assets that the proxy deliberately skips. The nonce-based
  // Content-Security-Policy lives in `src/proxy.ts` instead: its
  // `script-src` needs a fresh per-request nonce, which a static header
  // block can't express. These two layers merge (different header keys),
  // they don't clobber. HSTS is already set by Vercel; we re-assert it
  // here with `preload` so the file is the single source of truth.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
        ],
      },
      // Agents that read headers find the plain-Markdown install path from
      // any HTML page. Page routes only: no /api/*, no _next assets, no
      // file with an extension (mirrors the proxy.ts matcher).
      {
        source: "/((?!api/|_next/|.*\\.[^/]+$).*)",
        headers: [{ key: "Link", value: '</install.md>; rel="alternate"; type="text/markdown"' }],
      },
    ];
  },
};

export default config;
