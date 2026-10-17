import type { MetadataRoute } from "next";

const SITE = "https://www.tidegap.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${SITE}/`,             lastModified: now, changeFrequency: "hourly",  priority: 1.0 },
    { url: `${SITE}/about`,        lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${SITE}/forecast`,     lastModified: now, changeFrequency: "hourly",  priority: 0.8 },
    { url: `${SITE}/plan`,         lastModified: now, changeFrequency: "weekly",  priority: 0.8 },
    { url: `${SITE}/stats`,        lastModified: now, changeFrequency: "weekly",  priority: 0.7 },
    { url: `${SITE}/queue`,        lastModified: now, changeFrequency: "weekly",  priority: 0.6 },
    { url: `${SITE}/map`,          lastModified: now, changeFrequency: "hourly",  priority: 0.8 },
    { url: `${SITE}/docs`,         lastModified: now, changeFrequency: "weekly",  priority: 0.6 },
    { url: `${SITE}/architecture`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE}/install.md`,   lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE}/llms.txt`,     lastModified: now, changeFrequency: "monthly", priority: 0.5 },
  ];
}
