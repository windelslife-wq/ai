const CACHE_NAME = "windels-public-shell-v1";
const SHELL_URLS = [
  "/",
  "/styles.css",
  "/site.js",
  "/manifest.webmanifest",
  "/icons/windels-mark.svg",
  "/app/",
  "/app/asset-manifest.json"
];

async function precacheAppAssets(cache) {
  const response = await fetch("/app/asset-manifest.json", { cache: "no-store" });
  if (!response.ok) throw new Error("The app asset manifest is not available");
  const manifest = await response.json();
  const assets = new Set();
  for (const entry of Object.values(manifest)) {
    for (const file of [entry.file, ...(entry.css || []), ...(entry.assets || [])]) {
      if (typeof file === "string" && file.startsWith("assets/") && !file.includes("..")) {
        assets.add(`/app/${file}`);
      }
    }
  }
  if (assets.size) await cache.addAll([...assets]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        await cache.addAll(SHELL_URLS);
        await precacheAppAssets(cache);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("windels-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/") || url.pathname.startsWith("/private/")) return;

  if (request.mode === "navigate") {
    const appNavigation = url.pathname === "/app" || url.pathname.startsWith("/app/");
    const shellPath = appNavigation ? "/app/" : "/";
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(shellPath, copy));
        }
        return response;
      }).catch(async () => (await caches.match(shellPath)) || (await caches.match("/")))
    );
    return;
  }

  const isPublicAsset = ["/styles.css", "/site.js", "/manifest.webmanifest", "/icons/"].some((prefix) => url.pathname.startsWith(prefix))
    || (url.pathname.startsWith("/app/assets/") && !url.pathname.includes(".."));
  if (!isPublicAsset) return;
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok && response.type === "basic") {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }))
  );
});
