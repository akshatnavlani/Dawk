export type RateLimiter = {
  allow(key: string): boolean;
};

const DEFAULT_LIMIT = 10;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

export function createRateLimiter(options?: {
  limit?: number;
  windowMs?: number;
}): RateLimiter {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const hits = new Map<string, number[]>();

  return {
    allow(key) {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
  };
}
