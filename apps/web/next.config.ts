import type { NextConfig } from "next";

const apiTarget = process.env.LEAD_API_INTERNAL_URL ?? "http://127.0.0.1:3001";
const nextConfig: NextConfig = {
  output: "standalone",
  experimental: { externalDir: true },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiTarget}/api/:path*` }];
  },
};
export default nextConfig;
