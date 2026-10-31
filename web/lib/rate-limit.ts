import type { NextRequest } from "next/server";

/**
 * In-memory fixed-window rate limiter, keyed by client IP (and optional route prefix).
 * Automatically prunes expired buckets when the map grows past 500 entries so long-lived
 * Node processes do not accumulate unbounded keys.
 *
 * Usage:
 *   const rl = checkRateLimit(req, { max: 10, windowMs: 60_000, keyPrefix: "loyverse-save" });
 *   if (!rl.allowed) return NextResponse.json({ error: "..." }, { status: 429 });
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS_BEFORE_PRUNE = 500;

function pruneExpiredBuckets(now: number): void {
  if (buckets.size < MAX_BUCKETS_BEFORE_PRUNE) return;
  for (const [k, b] of buckets.entries()) {
    if (now >= b.resetAt) {
      buckets.delete(k);
    }
  }
}

export function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return (
    forwarded
      ? forwarded.split(",")[0].trim()
      : req.headers.get("x-real-ip") || "unknown"
  ).trim();
}

export function checkRateLimit(
  req: NextRequest,
  opts: { max: number; windowMs: number; keyPrefix?: string }
): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  pruneExpiredBuckets(now);

  const ip = clientIp(req);
  const key = opts.keyPrefix ? `${opts.keyPrefix}:${ip}` : ip;
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { allowed: true };
  }
  bucket.count += 1;
  if (bucket.count > opts.max) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  return { allowed: true };
}
