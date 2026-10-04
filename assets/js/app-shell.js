(() => {
  'use strict';

  const STORAGE_KEY = 'windels_dashboard_history_v1';
  const AUTHENTICATED_PREFIXES = [
    '/dashboard',
    '/analysis',
    '/app/languages',
    '/leads',
    '/lead-pipeline',
    '/paper',
    '/strategy',
    '/journal',
    '/execution',
    '/brokers',
    '/risk',
    '/sports',
    '/notifications',
    '/account',
    '/admin',
    '/leads',
  ];

  function isAuthenticatedPath(path) {
    if (!path) return false;
    // Must stay inside authenticated area - dashboard pages
    // Consider /dashboard and all prefixes above as authenticated
    if (path === '/dashboard') return true;
    return AUTHENTICATED_PREFIXES.some(p => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'));
  }

  function getCurrentPath() {
    return window.location.pathname + window.location.search;
  }

  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.stack) || typeof parsed.index !== 'number') return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function saveHistory(state) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  function initHistory() {
    let state = loadHistory();
    const cur = getCurrentPath();
    if (!state) {
      state = { stack: [cur], index: 0 };
      saveHistory(state);
      return state;
    }
    // If current path is not at current index, push it (truncate forward)
    if (state.stack[state.index] !== cur) {
      // If user directly navigated (e.g. typed URL or full reload), we push
      // but only if it's authenticated, otherwise we keep history
      if (isAuthenticatedPath(cur)) {
        state.stack = state.stack.slice(0, state.index + 1);
        state.stack.push(cur);
        state.index = state.stack.length - 1;
        // Cap to 50 entries
        if (state.stack.length > 50) {
          const excess = state.stack.length - 50;
          state.stack = state.stack.slice(excess);
          state.index = state.stack.length - 1;
        }
        saveHistory(state);
      }
    }
    return state;
  }

  function pushHistory(path) {
    let state = loadHistory() || { stack: [], index: -1 };
    if (state.stack[state.index] === path) return;
    state.stack = state.stack.slice(0, state.index + 1);
    state.stack.push(path);
    state.index = state.stack.length - 1;
    if (state.stack.length > 50) {
      const excess = state.stack.length - 50;
      state.stack = state.stack.slice(excess);
      state.index = state.stack.length - 1;
    }
    saveHistory(state);
    updateButtons();
  }

  function canGoBack() {
    const state = loadHistory();
    return state && state.index > 0;
  }

  function canGoForward() {
    const state = loadHistory();
    return state && state.index < state.stack.length - 1;
  }

  function updateButtons() {
    const backBtn = document.getElementById('dash-back');
    const fwdBtn = document.getElementById('dash-forward');
    if (!backBtn || !fwdBtn) return;
    backBtn.disabled = !canGoBack();
    fwdBtn.disabled = !canGoForward();
  }

  function navigateTo(path, { replace = false, spa = false } = {}) {
    if (!path) return;
    // Do not allow navigation to leave authenticated area unexpectedly without handling
    // If path is not authenticated and is not root or public, we still allow but via full navigation
    if (spa) {
      // SPA navigation will be handled by fetchAndSwap
      fetchAndSwap(path, replace);
    } else {
      if (replace) {
        window.location.replace(path);
      } else {
        window.location.assign(path);
      }
    }
  }

  function goBack() {
    const state = loadHistory();
    if (!state || state.index <= 0) return;
    const target = state.stack[state.index - 1];
    if (!target) return;
    state.index -= 1;
    saveHistory(state);
    updateButtons();
    // Use SPA if target is authenticated, otherwise full navigation
    if (isAuthenticatedPath(target)) {
      fetchAndSwap(target, true, false);
    } else {
      window.location.assign(target);
    }
  }

  function goForward() {
    const state = loadHistory();
    if (!state || state.index >= state.stack.length - 1) return;
    const target = state.stack[state.index + 1];
    if (!target) return;
    state.index += 1;
    saveHistory(state);
    updateButtons();
    if (isAuthenticatedPath(target)) {
      fetchAndSwap(target, true, false);
    } else {
      window.location.assign(target);
    }
  }

  // ---------- SPA fetch & swap to keep sidebar mounted ----------
  // Latest-navigation-wins token: rapid back/forward (or quick clicks) must
  // never leave a stale page mounted under a newer URL. Every navigation
  // increments the token; only the newest fetch is allowed to swap.
  let navSeq = 0;

  // External scripts already executed in this browser session. Their
  // globals survive SPA swaps, so swapped-in copies must not re-run.
  const executedScripts = new Set(
    Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src'))
  );
  async function fetchAndSwap(path, replaceHistory = false, pushAppHistory = true) {
    if (!isAuthenticatedPath(path)) {
      // Outside authenticated area - do full navigation
      navigateTo(path, { replace: replaceHistory, spa: false });
      return;
    }
    const seq = ++navSeq;
    const pageContent = document.getElementById('page-content');
    if (pageContent) {
      pageContent.style.opacity = '0.6';
    }
    try {
      const res = await fetch(path, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin',
      });
      if (seq !== navSeq) return; // superseded by a newer navigation
      if (!res.ok) {
        throw new Error('HTTP ' + res.status);
      }
      const html = await res.text();
      if (seq !== navSeq) return; // superseded while parsing
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // Only pages rendered inside the dashboard shell have #app-main.
      // Standalone documents (e.g. Lead Discovery) must load with a full
      // navigation — swapping only a fragment leaves their scripts dead.
      const newMain = doc.getElementById('app-main');
      const newTitle = doc.querySelector('title');

      if (!newMain) {
        throw new Error('Target page is not an app-shell page');
      }

      const currentMain = document.getElementById('app-main');
      if (!currentMain) {
        throw new Error('Current page lost #app-main');
      }
      currentMain.innerHTML = newMain.innerHTML;

      // innerHTML never executes <script> tags — re-create them so page
      // scripts (language lessons, speaking/listening tools, etc.) run
      // after every SPA swap, exactly like a full page load.
      // External scripts run once per browser session (their globals
      // persist across swaps); inline scripts run on every swap.
      currentMain.querySelectorAll('script').forEach((oldScript) => {
        const src = oldScript.getAttribute('src');
        if (src) {
          if (executedScripts.has(src)) {
            oldScript.remove();
            return;
          }
          executedScripts.add(src);
        }
        const fresh = document.createElement('script');
        for (const attr of oldScript.attributes) fresh.setAttribute(attr.name, attr.value);
        if (!src) fresh.textContent = oldScript.textContent;
        oldScript.replaceWith(fresh);
      });

      // Page scripts that wait for DOMContentLoaded must still initialize:
      // the real event fired long ago, so re-notify after the swap.
      try {
        document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: false, cancelable: false }));
      } catch (_) {}

      // Update document title
      if (newTitle) {
        document.title = newTitle.textContent;
      }

      // Update browser history
      if (replaceHistory) {
        history.replaceState({ windels: true, path }, '', path);
      } else {
        history.pushState({ windels: true, path }, '', path);
      }

      // Update our app history stack
      if (pushAppHistory) {
        if (replaceHistory) {
          // replace current entry
          let state = loadHistory();
          if (state) {
            state.stack[state.index] = path;
            saveHistory(state);
          }
        } else {
          pushHistory(path);
        }
      }

      // Update active sidebar links
      updateActiveLinks(path);

      // Re-initialize UI components
      initUI();

      // Scroll to top of content (or to the target section when the
      // navigation carries a #fragment, e.g. profile menu → Security)
      const wrap = document.getElementById('page-content');
      if (wrap) wrap.scrollTop = 0;
      window.scrollTo(0, 0);
      const hash = (path.split('#')[1] || '').trim();
      if (hash) {
        const target = document.getElementById(hash);
        if (target) target.scrollIntoView({ block: 'start', behavior: 'auto' });
      }

      updateButtons();
    } catch (err) {
      // Fallback to full navigation on failure (but never override a newer navigation)
      if (seq !== navSeq) return;
      console.warn('SPA navigation failed, falling back', err);
      if (replaceHistory) {
        window.location.replace(path);
      } else {
        window.location.assign(path);
      }
    } finally {
      if (seq === navSeq && pageContent) pageContent.style.opacity = '';
    }
  }

  function updateActiveLinks(path) {
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;
    const links = sidebar.querySelectorAll('a[href]');
    links.forEach(a => {
      const href = a.getAttribute('href');
      if (!href) return;
      // Simple active logic: exact match or prefix for language etc
      const cleanPath = path.split('?')[0].split('#')[0];
      const cleanHref = href.split('?')[0].split('#')[0];
      if (cleanPath === cleanHref) {
        a.classList.add('active');
      } else if (cleanHref !== '/dashboard' && cleanPath.startsWith(cleanHref + '/')) {
        // For sub-paths, keep parent active if no exact child active
        // Only add active if no other link is exact active
        // We'll handle by checking if any exact match exists later
        // For now, don't auto-add
      } else {
        a.classList.remove('active');
      }
    });
    // If no active after loop, try prefix match
    let hasActive = sidebar.querySelector('a.active');
    if (!hasActive) {
      links.forEach(a => {
        const href = a.getAttribute('href');
        if (!href) return;
        const cleanPath = path.split('?')[0].split('#')[0];
        const cleanHref = href.split('?')[0].split('#')[0];
        if (cleanHref !== '/' && cleanPath.startsWith(cleanHref)) {
          a.classList.add('active');
        }
      });
    }
    // Update page title element if needed
    const titleEl = document.getElementById('page-title');
    if (titleEl) {
      // Try to get title from active link text
      const activeLink = sidebar.querySelector('a.active span');
      if (activeLink) {
        // Keep existing title, but could update
      }
    }
  }

  // ---------- UI init (sidebar toggle, profile menu, back/forward) ----------
  function initUI() {
    const toggle = document.getElementById('sidebar-toggle') || document.querySelector('.sidebar-toggle');
    const sidebar = document.getElementById('app-sidebar');
    if (toggle && sidebar) {
      // Remove old listeners by cloning? Simpler: use a flag
      if (!toggle.dataset.bound) {
        toggle.dataset.bound = '1';
        const setOpen = (open) => {
          document.body.classList.toggle('sidebar-open', open);
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        };
        toggle.addEventListener('click', (ev) => {
          ev.stopPropagation();
          setOpen(!document.body.classList.contains('sidebar-open'));
        });
        sidebar.addEventListener('click', (ev) => {
          const a = ev.target.closest('a[href]');
          if (a) setOpen(false);
        });
        document.addEventListener('click', (ev) => {
          if (!document.body.classList.contains('sidebar-open')) return;
          if (sidebar.contains(ev.target) || toggle.contains(ev.target)) return;
          setOpen(false);
        });
        document.addEventListener('keydown', (ev) => {
          if (ev.key === 'Escape') setOpen(false);
        });
      }
    }

    const profileBtn = document.getElementById('profile-btn');
    const profileMenu = document.getElementById('profile-menu');
    if (profileBtn && profileMenu && !profileBtn.dataset.bound) {
      profileBtn.dataset.bound = '1';
      const setMenu = (open) => {
        profileMenu.classList.toggle('open', open);
        profileBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
      profileBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setMenu(!profileMenu.classList.contains('open'));
      });
      document.addEventListener('click', (ev) => {
        if (!profileMenu.contains(ev.target) && !profileBtn.contains(ev.target)) setMenu(false);
      });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') setMenu(false);
      });
    }

    const backBtn = document.getElementById('dash-back');
    const fwdBtn = document.getElementById('dash-forward');
    if (backBtn && !backBtn.dataset.bound) {
      backBtn.dataset.bound = '1';
      backBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        goBack();
      });
    }
    if (fwdBtn && !fwdBtn.dataset.bound) {
      fwdBtn.dataset.bound = '1';
      fwdBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        goForward();
      });
    }

    // Intercept dashboard link clicks for SPA navigation (keeps sidebar mounted)
    document.querySelectorAll('a[data-dashboard-link]').forEach(a => {
      if (a.dataset.spaBound) return;
      a.dataset.spaBound = '1';
      a.addEventListener('click', (ev) => {
        const href = a.getAttribute('href');
        if (!href) return;
        // Only handle same-origin, GET, no target blank, no download
        if (a.target && a.target !== '_self') return;
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
        if (href.startsWith('http') && !href.startsWith(window.location.origin)) return;
        // If href is authenticated path, use SPA
        const url = new URL(href, window.location.origin);
        // Keep the #fragment so the landing page can scroll to the section
        // (e.g. profile menu → Security). fetch() ignores it for the request.
        const path = url.pathname + url.search + url.hash;
        if (!isAuthenticatedPath(path.split('#')[0])) return; // let browser handle public navigation
        ev.preventDefault();
        fetchAndSwap(path, false, true);
      });
    });

    updateButtons();
  }

  // ---------- Popstate handling ----------
  window.addEventListener('popstate', (ev) => {
    const path = window.location.pathname + window.location.search;
    // Sync our history stack index to this path if it exists
    const state = loadHistory();
    if (state) {
      const idx = state.stack.indexOf(path);
      if (idx !== -1) {
        state.index = idx;
        saveHistory(state);
      } else {
        // If path not in stack, push it (user used browser back to outside our stack)
        if (isAuthenticatedPath(path)) {
          pushHistory(path);
        }
      }
    }
    updateButtons();
    // If the popstate was from our SPA push, the content is already swapped? No, browser back will not have swapped content, so we need to fetch
    // Only fetch if the page content doesn't match the path (we can check if we are in SPA mode)
    // For simplicity, if the event state has windels flag, we fetch, otherwise we let full reload happen? But we want to keep sidebar mounted.
    // So we fetch if it's an authenticated path.
    if (isAuthenticatedPath(path)) {
      // Avoid double fetch if we already are at that path and content is fresh? We'll fetch anyway to ensure content matches.
      // Use replace to not push duplicate
      fetchAndSwap(path, true, false);
    }
  });

  // ---------- Init ----------
  initHistory();
  initUI();
  updateButtons();

  // Expose for debugging
  window.WindelsDashboard = {
    back: goBack,
    forward: goForward,
    canBack: canGoBack,
    canForward: canGoForward,
    history: loadHistory,
  };
})();
