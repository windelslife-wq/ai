import type { MetadataRoute } from "next";
import { seoSettings } from "../lib/seo";

export default function robots(): MetadataRoute.Robots { return { rules: [{ userAgent: "*", allow: seoSettings.robots.includes("index") ? "/" : undefined, disallow: ["/admin", "/account", "/api/"] }], sitemap: `${seoSettings.siteUrl}/sitemap.xml` }; }
