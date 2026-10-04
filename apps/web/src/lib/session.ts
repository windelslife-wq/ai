export const tokenKey = "lead-api-token";
export const refreshKey = "lead-refresh-token";
export const getAccessToken = (): string => typeof window === "undefined" ? "" : window.localStorage.getItem(tokenKey) ?? "";
export const saveSessionTokens = (token: string, refreshToken: string): void => { window.localStorage.setItem(tokenKey, token); window.localStorage.setItem(refreshKey, refreshToken); };
export const clearSessionTokens = (): void => { window.localStorage.removeItem(tokenKey); window.localStorage.removeItem(refreshKey); };
