/**
 * Public-site behaviour: navigation, the service-worker update flow (F-09) and
 * the progressive enhancement of the contact form.
 *
 * No inline handlers anywhere — the CSP is `script-src 'self'` in production, so
 * everything here is bound with addEventListener. This file stays framework-free
 * on purpose: it is the only script a marketing page loads.
 */
(() => {
  "use strict";

  const menuButton = document.querySelector(".menu-toggle");
  const navigation = document.querySelector(".site-nav");

  if (menuButton && navigation) {
    menuButton.addEventListener("click", () => {
      const isOpen = menuButton.getAttribute("aria-expanded") === "true";
      menuButton.setAttribute("aria-expanded", String(!isOpen));
      menuButton.setAttribute("aria-label", isOpen ? "Open navigation" : "Close navigation");
      navigation.classList.toggle("is-open", !isOpen);
    });
    navigation.addEventListener("click", (event) => {
      if (event.target instanceof HTMLAnchorElement) {
        menuButton.setAttribute("aria-expanded", "false");
        menuButton.setAttribute("aria-label", "Open navigation");
        navigation.classList.remove("is-open");
      }
    });
  }

  // ---- banners ------------------------------------------------------------

  const bannerHost = document.createElement("div");
  bannerHost.className = "pwa-banner-host";
  document.body.appendChild(bannerHost);

  function showBanner({ text, offline = false, actions = [] }) {
    dismissBanner();
    const banner = document.createElement("div");
    banner.className = `pwa-banner${offline ? " is-offline" : ""}`;
    banner.setAttribute("role", "status");
    const message = document.createElement("span");
    message.textContent = text;
    banner.appendChild(message);
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      if (action.secondary) button.className = "pwa-dismiss";
      button.addEventListener("click", action.onClick);
      banner.appendChild(button);
    }
    bannerHost.appendChild(banner);
    return banner;
  }

  function dismissBanner() {
    for (const existing of bannerHost.querySelectorAll(".pwa-banner")) existing.remove();
  }

  function bindConnectivity() {
    const update = () => {
      if (navigator.onLine) dismissBanner();
      else showBanner({ text: "You are offline. Cached pages stay readable; anything that needs the server waits.", offline: true });
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
  }

  // ---- service worker: install, update, offer the reload -------------------

  let refreshing = false;

  function bindServiceWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.addEventListener("message", () => {
      // An activated worker announces itself; the banner for a *waiting* worker
      // is replaced by nothing because controllerchange already reloaded the page.
    });

    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).then((registration) => {
        // A worker waiting behind the current controller means a new shell exists.
        const offerUpdate = (worker) => {
          if (!worker) return;
          showBanner({
            text: "A new version of this site is ready.",
            actions: [
              {
                label: "Reload",
                onClick: () => {
                  worker.postMessage({ type: "SKIP_WAITING" });
                },
              },
              { label: "Not now", secondary: true, onClick: dismissBanner },
            ],
          });
        };
        if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) offerUpdate(installing);
          });
        });
        registration.update?.();
      }).catch(() => {
        document.documentElement.dataset.offlineSupport = "unavailable";
      });
    }, { once: true });
  }

  // ---- contact form: JSON first, plain form as the fallback ----------------

  function bindContactForm() {
    const form = document.querySelector("[data-contact-form]");
    if (!form) return;
    const slot = document.querySelector(".flash-slot");

    const note = (tone, message) => {
      if (!slot) return;
      slot.innerHTML = "";
      const box = document.createElement("div");
      box.className = `flash ${tone === "error" ? "flash-error" : "flash-ok"}`;
      box.setAttribute("role", tone === "error" ? "alert" : "status");
      box.textContent = message;
      slot.appendChild(box);
    };

    form.addEventListener("submit", async (event) => {
      // Without fetch (or with it blocked) the browser submits the classic form;
      // that path still works because the server renders the flash on redirect.
      if (typeof fetch !== "function") return;
      event.preventDefault();
      const data = new FormData(form);
      const payload = {
        name: String(data.get("name") || ""),
        email: String(data.get("email") || ""),
        message: String(data.get("message") || ""),
      };
      const button = form.querySelector("button[type=submit]");
      if (button) button.disabled = true;
      try {
        const response = await fetch("/api/v1/site/contact", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await response.json().catch(() => null);
        if (response.ok && body) {
          note("ok", body.notice || "Thank you. Your message was recorded.");
          form.reset();
        } else {
          const detail = body?.error?.details?.[0];
          note("error", detail ? `${detail.field.replace(/^body\./, "")} ${detail.message}` : (body?.error?.message || "The message could not be sent."));
        }
      } catch {
        note("error", "The network is unavailable. Your message was not sent — the form still works offline-safe: reload and try again.");
      } finally {
        if (button) button.disabled = false;
      }
    });
  }

  bindConnectivity();
  bindServiceWorker();
  bindContactForm();
})();
