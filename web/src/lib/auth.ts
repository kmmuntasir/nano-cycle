import { canRedirectToLogin } from "./backoff";

// The server answers unauthenticated API calls with JSON 401 and serves a
// self-contained login page at /login. The SPA holds no credentials itself —
// it only needs to notice the 401 and hand the browser over, exactly once.

const KEY = "nano-cycle-login-redirect-at";
let redirecting = false;

export function redirectToLogin(): void {
  if (redirecting) return;
  if (location.pathname === "/login") return;
  let last: number | null = null;
  try {
    const raw = sessionStorage.getItem(KEY);
    last = raw ? Number(raw) : null;
  } catch {
    /* storage blocked — the in-memory flag still guards this page load */
  }
  // A redirect that lands straight back here with another 401 means login
  // can't succeed (cookie blocked, clock skew…): stop instead of looping.
  if (!canRedirectToLogin(last, Date.now())) return;
  redirecting = true;
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  location.assign("/login");
}
