// Pure helpers for the reconnecting socket — kept free of browser globals so
// they can be unit-tested under node (tests/web-lib.test.mjs).

export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 30_000;

/** Exponential backoff with 50–100% jitter: ~0.5s, 1s, 2s … capped at 30s. */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
  return Math.round(base / 2 + (rand() * base) / 2);
}

/** Append a batch to a capped event buffer (keeps the newest `cap`). */
export function capAppend<T>(prev: T[], batch: T[], cap: number): T[] {
  if (batch.length === 0) return prev;
  const next = prev.concat(batch);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Loop guard for the login redirect: allow at most one redirect per window. */
export function canRedirectToLogin(lastAt: number | null, now: number, windowMs = 15_000): boolean {
  return lastAt === null || !Number.isFinite(lastAt) || now - lastAt > windowMs;
}
