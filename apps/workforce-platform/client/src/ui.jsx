/**
 * Shared UI primitives: the four states every data view must show (loading,
 * empty, error, ready), permission and connectivity notices, and the service
 * worker update banner.
 *
 * A view that fetches data and renders only its happy path is how a migration
 * hides failures; `useResource` makes the other three states the default.
 */

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./api.js";

export function useResource(loader, deps = []) {
  const [state, setState] = useState({ status: "loading", data: null, error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, status: "loading", error: null }));
    loader()
      .then((data) => { if (!cancelled) setState({ status: "ready", data, error: null }); })
      .catch((error) => { if (!cancelled) setState({ status: "error", data: null, error }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const retry = useCallback(() => setNonce((value) => value + 1), []);
  return { ...state, retry };
}

export function StateBox({ status, error, empty = null, children, retry, label = "Loading" }) {
  if (status === "loading") {
    return <div className="state-box state-loading" role="status"><span className="state-dot" />{label}…</div>;
  }
  if (status === "error") {
    const apiError = error instanceof ApiError ? error : null;
    return (
      <div className="state-box state-error" role="alert">
        <strong>{apiError ? apiError.message : "The request failed."}</strong>
        {apiError?.code ? <span className="state-code">{apiError.code}</span> : null}
        {apiError?.retryAfter ? <span>Try again in about {apiError.retryAfter}s.</span> : null}
        {apiError?.isPermissionFailure ? <span>Your role does not include this surface. The server refused it; nothing is hidden by accident.</span> : null}
        {retry ? <button type="button" className="text-button" onClick={retry}>Retry</button> : null}
      </div>
    );
  }
  if (empty !== null && status === "ready") return empty;
  return children;
}

export function Notice({ tone = "info", children }) {
  return <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}

export function Field({ label, htmlFor, error, hint, children }) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error" role="alert">{error}</span> : null}
    </label>
  );
}

export function PermissionTag({ permissions }) {
  if (!permissions?.length) return <span className="permission-empty">No permissions assigned</span>;
  return <span className="permission-list-inline">{permissions.map((permission) => <code key={permission}>{permission}</code>)}</span>;
}

/** Connectivity banner: offline the SPA can still show cached shell, never data. */
export function ConnectivityBanner() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  if (online) return null;
  return <Notice tone="warn">You are offline. The workspace shell is cached; every figure below needs the server and is not shown from memory.</Notice>;
}

/**
 * Service worker update flow (F-09): when a new worker is waiting, offer the
 * reload instead of swapping the shell under an open session.
 */
export function UpdateBanner() {
  const [waiting, setWaiting] = useState(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return undefined;
    let registrationRef = null;
    const offer = (worker) => setWaiting(() => worker);
    const onControllerChange = () => window.location.reload();

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker.register("/service-worker.js", { scope: "/" })
      .then((registration) => {
        registrationRef = registration;
        if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) offer(installing);
          });
        });
      })
      .catch(() => {});
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      registrationRef?.removeEventListener?.("updatefound", () => {});
    };
  }, []);

  if (!waiting) return null;
  return (
    <div className="update-banner" role="status">
      <span>A new version of the workspace is ready.</span>
      <button type="button" className="text-button" onClick={() => waiting.postMessage({ type: "SKIP_WAITING" })}>Reload</button>
      <button type="button" className="text-button muted" onClick={() => setWaiting(null)}>Not now</button>
    </div>
  );
}
