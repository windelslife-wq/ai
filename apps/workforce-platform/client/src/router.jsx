/**
 * A history-API router for the workspace SPA.
 *
 * Deliberately tiny: the platform already ships one router (the Node transport's)
 * and the SPA needs path → view with guards, back/forward, and intercepted clicks
 * so in-app navigation never reloads the shell. No dependency, no pattern magic —
 * routes are exact paths, because every workspace path is a declared surface in
 * the parity ledger and a wildcard would let an undeclared one render.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const RouterContext = createContext({ path: "/", navigate: () => {} });

export function RouterProvider({ basePath = "/app", children }) {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((target, { replace = false } = {}) => {
    const next = target.startsWith("/") ? target : `${basePath}/${target}`;
    if (next === window.location.pathname) return;
    if (replace) window.history.replaceState({}, "", next);
    else window.history.pushState({}, "", next);
    setPath(next);
    window.scrollTo({ top: 0 });
  }, [basePath]);

  const value = useMemo(() => ({ path, navigate, basePath }), [path, navigate, basePath]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  return useContext(RouterContext);
}

/** An in-app anchor: intercepted, so the shell and session survive navigation. */
export function Link({ to, children, className, ...rest }) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      className={className}
      {...rest}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Resolves the current path against a route table. Guards are evaluated by the
 * caller (App) so a view never has to re-check what the server enforces anyway.
 */
export function matchRoute(routes, path) {
  const normalized = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  return routes.find((route) => route.path === normalized || route.path === path) || null;
}
