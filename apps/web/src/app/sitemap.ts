import type { MetadataRoute } from "next";
import { seoSettings } from "../lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  const updated = new Date();
  return ["/", "/app/leads", "/app/lead-pipeline", "/collections", "/intelligence", "/login"].map(path => ({ url: `${seoSettings.siteUrl}${path}`, lastModified: updated, changeFrequency: path === "/" ? "weekly" : "monthly", priority: path === "/" ? 1 : 0.7 }));
}
