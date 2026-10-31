import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext, hasWorkspaceWriteAccess, resolveBrandId } from "@/lib/auth";

/**
 * POST /api/integrations/google/watch
 * (Re)establish the connected brand's Google Gmail push watch by forwarding the
 * JWT-authenticated call to FastAPI `POST /api/v1/ingestion/gmail/watch`.
 *
 * Gmail push watches expire after ~7 days. This route (plus the best-effort
 * re-establishment on OAuth connect + manual sync) keeps real-time Pub/Sub
 * delivery alive so settlement emails push without a manual "Sync Now".
 *
 * SECURITY:
 *  - brand_id is resolved server-side via resolveBrandId(ctx, ...) and
 *    membership-checked by FastAPI's resolve_brand_id_from_scope — a client can
 *    never watch a brand outside its own tenant.
 *  - Forwarded with the LIVE Supabase session access token as a JWT Bearer
 *    (FastAPI authenticates via JWKS). The refresh token is never read/returned.
 *  - Fixed-window in-memory rate limit (10/min/IP).
 */

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  const realIp = req.headers.get("x-real-ip");
  return realIp?.trim() || "unknown";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ---- Auth ----
  const ctx = await getTenantUserContext();
  if (!ctx || !ctx.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasWorkspaceWriteAccess(ctx)) {
    return NextResponse.json({ error: "PARTNER_READ_ONLY" }, { status: 403 });
  }

  // ---- Resolve tenant brand_id server-side (never trust a raw client id) ----
  let requestedBrand: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body === "object" && typeof (body as any).brand_id === "string") {
      requestedBrand = (body as any).brand_id as string;
    }
  } catch {
    // fall through to primary-brand resolution
  }
  const brandId = resolveBrandId(ctx, requestedBrand);
  if (!brandId) {
    return NextResponse.json({ error: "NO_TENANT_BRAND" }, { status: 403 });
  }

  // ---- Fixed-window rate limit: 10 requests / min / IP ----
  const ip = clientIp(req);
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    rateBuckets.set(ip, bucket);
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((bucket.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Max 10 watch requests per minute per IP." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }
  bucket.count += 1;

  // ---- Live Supabase session access token (JWT Bearer for FastAPI) ----
  const supabase = await createClient();
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (sessionError || !accessToken) {
    return NextResponse.json(
      { error: "NO_SESSION_TOKEN", message: "No live Supabase session access token available." },
      { status: 401 }
    );
  }

  // ---- Forward to FastAPI ----
  const baseUrl = process.env.INGESTION_API_BASE_URL?.trim() || "http://localhost:8080";
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/ingestion/gmail/watch`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ brand_id: brandId }),
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err: any) {
    console.error("[WATCH] FastAPI watch forward failed:", err?.message || err);
    return NextResponse.json({ error: "WATCH_FORWARD_FAILED", message: err?.message || String(err) }, { status: 500 });
  }
}
