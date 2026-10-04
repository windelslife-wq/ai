import type { MetadataRoute } from "next";
import { seoSettings } from "../lib/seo";

export default function manifest(): MetadataRoute.Manifest { return { name: seoSettings.siteName, short_name: "WINDELS", description: seoSettings.description, start_url: "/", display: "standalone", background_color: "#07101d", theme_color: "#07101d", icons: [{ src: "/images/windels-mark.png", sizes: "64x64", type: "image/png" }] }; }
