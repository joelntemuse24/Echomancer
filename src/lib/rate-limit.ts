// In-memory IP-based rate limiter
// Shared across API routes that need throttling

const rateLimitMaps = new Map<string, Map<string, { count: number; resetAt: number }>>();

export function createRateLimiter(max: number, windowMs: number) {
  const key = `${max}:${windowMs}`;
  if (!rateLimitMaps.has(key)) {
    rateLimitMaps.set(key, new Map());
  }
  const map = rateLimitMaps.get(key)!;

  return function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = map.get(ip);
    if (!entry || now > entry.resetAt) {
      map.delete(ip);
      map.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= max;
  };
}
