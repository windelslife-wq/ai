export type SeoSettings = { siteName: string; title: string; description: string; keywords: string[]; siteUrl: string; ogImage: string; robots: string };

const rawKeywords = process.env.NEXT_PUBLIC_SITE_KEYWORDS ?? "WINDELS AI WORKFORCE,AI workforce,language learning,AI language teacher,trading intelligence,lead discovery,sports intelligence";
export const seoSettings: SeoSettings = {
  siteName: process.env.NEXT_PUBLIC_SITE_NAME ?? "WINDELS AI WORKFORCE",
  title: process.env.NEXT_PUBLIC_SITE_TITLE ?? "WINDELS AI WORKFORCE",
  description: process.env.NEXT_PUBLIC_SITE_DESCRIPTION ?? "WINDELS AI WORKFORCE — an AI-powered workforce platform for language learning, market analysis, sports intelligence, lottery research and lead discovery. Evidence-first, audited and fail-closed.",
  keywords: rawKeywords.split(",").map(value => value.trim()).filter(Boolean),
  siteUrl: (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  ogImage: process.env.NEXT_PUBLIC_OG_IMAGE ?? "/images/windels-mark.png",
  robots: process.env.NEXT_PUBLIC_ROBOTS ?? "index,follow",
};
