# @grooming/api-client

Typed client for the Grooming API. No DOM or Node types: you inject `fetch`.

- `baseUrl` is the API origin (e.g. `http://localhost:3001`); the client adds `/v1`.
  `request({ path })` takes the path after `/v1` (e.g. `/me`).
- Web: `transport: "cookie"`, `createCookieTokenStore()`, `fetch: window.fetch.bind(window)`.
  The refresh token stays in an httpOnly cookie; refresh/logout send `x-grooming-csrf: 1`.
- Native: `transport: "body"`, a `TokenStore` backed by secure storage (or `MemoryTokenStore`).
  Token-issuing calls send `x-token-transport: body`.
- A 401 on an authed call triggers one shared refresh (also shared with `auth.refresh()`) and one retry.
  `onSessionExpired` fires, and the store is cleared, only when a refresh is answered 401 or 403
  (including an anonymous `auth.refresh()` at boot); the request then throws its original 401.
  Network errors, 5xx and 429 on refresh leave the session intact and the refresh error itself is
  thrown, so callers can tell an outage from a logout.
- `refreshLock` (optional): `<T>(fn: () => Promise<T>) => Promise<T>`; each shared refresh runs inside it.
  Web should pass `(fn) => navigator.locks.request("gr-refresh", fn)` (wired in plan 06) so two tabs never
  rotate the same refresh token at once; the package itself has no DOM types.
- `auth.logout()` first waits for an in-flight refresh (ignoring its outcome), so a late refresh can never
  store tokens after the store was cleared; with body transport it then logs out the freshly issued token.
- Errors are `ApiError` with a contracts `Problem` (`err.problem.code`).
