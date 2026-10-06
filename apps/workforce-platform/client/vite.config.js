import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const nativeBuild = process.env.CAPACITOR_BUILD === "1";
const nativeApiBase = process.env.VITE_API_BASE_URL || "";
if (nativeBuild) {
  let apiUrl;
  try {
    apiUrl = new URL(nativeApiBase);
  } catch {
    throw new Error("Native builds require VITE_API_BASE_URL to be an absolute HTTPS origin");
  }
  const host = apiUrl.hostname.toLowerCase();
  const apiHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const ipParts = apiHost.split(".");
  const isLoopbackIpv4 = ipParts.length === 4 && ipParts[0] === "127"
    && ipParts.every((part) => part !== "" && Number.isInteger(Number(part)) && Number(part) >= 0 && Number(part) <= 255);
  const isLoopback = apiHost === "localhost" || apiHost.endsWith(".localhost") || apiHost === "::1"
    || apiHost === "0.0.0.0" || isLoopbackIpv4;
  if (apiUrl.protocol !== "https:" || isLoopback || apiUrl.username || apiUrl.password || apiUrl.pathname !== "/" || apiUrl.search || apiUrl.hash) {
    throw new Error("VITE_API_BASE_URL for native builds must be a clean, non-local HTTPS origin without credentials, path, query, or fragment");
  }
}

export default defineConfig({
  base: nativeBuild ? "/" : "/app/",
  plugins: [react()],
  define: {
    __NATIVE_BUILD__: JSON.stringify(nativeBuild),
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/api/v1": {
        target: process.env.API_PROXY_TARGET || "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    outDir: path.resolve("../public/app"),
    emptyOutDir: true,
    sourcemap: false,
    manifest: "asset-manifest.json",
    assetsDir: "assets",
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
