import "./globals.css";
import type { Metadata } from "next";
import { AssistantWidget } from "../components/assistant/AssistantWidget";
import { seoSettings } from "../lib/seo";

const absoluteImage = seoSettings.ogImage.startsWith("http") ? seoSettings.ogImage : `${seoSettings.siteUrl}${seoSettings.ogImage}`;
export const metadata: Metadata = {
  metadataBase: new URL(seoSettings.siteUrl),
  title: { default: seoSettings.title, template: `%s · ${seoSettings.siteName}` },
  description: seoSettings.description,
  keywords: seoSettings.keywords,
  applicationName: seoSettings.siteName,
  authors: [{ name: seoSettings.siteName }],
  creator: seoSettings.siteName,
  alternates: { canonical: "/" },
  openGraph: { type: "website", locale: "en_US", url: seoSettings.siteUrl, siteName: seoSettings.siteName, title: seoSettings.title, description: seoSettings.description, images: [{ url: absoluteImage, width: 512, height: 512, alt: `${seoSettings.siteName} logo` }] },
  twitter: { card: "summary_large_image", title: seoSettings.title, description: seoSettings.description, images: [absoluteImage] },
  robots: { index: seoSettings.robots.includes("index"), follow: seoSettings.robots.includes("follow") },
  icons: { icon: "/images/windels-mark.png", shortcut: "/images/windels-mark.png", apple: "/images/windels-mark.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}<AssistantWidget /></body></html>; }
