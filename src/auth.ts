/** Signals that we need the user to go through the interactive consent flow. */
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

function getAuthToken(interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err || !token) {
        reject(new AuthRequiredError(err?.message ?? "No auth token returned"));
      } else {
        resolve(token as string);
      }
    });
  });
}

function removeCachedToken(token: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

/** Silent token check — throws AuthRequiredError if consent hasn't been granted. */
export function ensureSignedIn(): Promise<string> {
  return getAuthToken(false);
}

/** Interactive consent flow (must be called from a user gesture). */
export function signIn(): Promise<string> {
  return getAuthToken(true);
}

/**
 * Sign out and actually disconnect: revoke the grant at Google before dropping
 * the local caches, so "Sign out" leaves nothing behind on the account either.
 * The token goes in the POST body rather than the query string so it can't be
 * captured in any intermediate request log.
 */
export async function signOut(): Promise<void> {
  try {
    const token = await getAuthToken(false);
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    }).catch(() => {
      // Offline, or already revoked — clearing the local caches below still
      // signs the user out here; the grant can be removed from their Google
      // account page instead.
    });
    await removeCachedToken(token);
  } catch {
    // Not signed in — nothing to do.
  }
  await new Promise<void>((resolve) => chrome.identity.clearAllCachedAuthTokens(() => resolve()));
}

/**
 * Drop the currently cached token (e.g. after a 403 for insufficient scopes,
 * which happens when the manifest's scopes grew after the original grant).
 * The next getAuthToken will then mint against the current scope set.
 */
export async function invalidateToken(): Promise<void> {
  try {
    const token = await getAuthToken(false);
    await removeCachedToken(token);
  } catch {
    // No cached token — nothing to invalidate.
  }
}

export interface FetchOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON-serialized into the request body when provided. */
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Fetch with a bearer token. On 401 the cached token is stale: drop it and
 * retry once with a freshly minted one (Chrome refreshes it silently).
 */
export async function authorizedFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const { method = "GET", body, headers } = options;
  const init = (token: string): RequestInit => ({
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let token = await getAuthToken(false);
  let res = await fetch(url, init(token));
  if (res.status === 401) {
    await removeCachedToken(token);
    token = await getAuthToken(false);
    res = await fetch(url, init(token));
  }
  return res;
}
