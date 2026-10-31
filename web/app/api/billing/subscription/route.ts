import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext, resolveBrandId } from "@/lib/auth";

/**
 * GET /api/billing/subscription
 * Tenant proxy to fetch the current brand's subscription status.
 *
 * Resolves the tenant brand_id SERVER-SIDE from the authenticated session (a
 * client-selected store is honored ONLY if it is in the user's own brand set)
 * and forwards to `${INGESTION_API_BASE_URL}/api/v1/billing/subscription`
 * with the user's LIVE Supabase access token as `Authorization: Bearer ***
 * (FastAPI verifies the JWT via JWKS and membership-checks brand_id). Returns
 * the subscription row, or `{ status: "none" }` when the brand has no
 * subscription.
 *
 * SECURITY: tenant session required (401); brand_id resolved via resolveBrandId
 * (client brand honored ONLY if in the user's own brand set, else primary; 400
 * NO_BRAND_LINKED if absent); fixed-window rate limit (10/min/IP); env secrets.
 */

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;

// Fixed-window rate limiter (in-memory, single-instance; sufficient here).
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: NextRequest): { allowed: boolean; retryAfterMs?: number } {
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = (
    forwarded ? forwarded.split(",")[0].trim() : req.headers.get("x-real-ip") || "unknown"
  ).trim();
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  return { allowed: true };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ---- Rate limit (before auth so abuse is cheap to reject) ----
  const rl = rateLimit(req);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please retry later." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil((rl.retryAfterMs ?? 60_000) / 1000)) },
      }
    );
  }

  // ---- Auth: require a tenant session ----
  const ctx = await getTenantUserContext();
  if (!ctx || !ctx.userId) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "Please sign in." },
      { status: 401 }
    );
  }

  // Live Supabase access token for JWT auth upstream (ES256 / JWKS).
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  if (!accessToken) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "Please sign in." },
      { status: 401 }
    );
  }

  // ---- Resolve brand_id server-side with a membership check. The client may
  // OPTIONALLY send ?brand_id= to select one of THEIR stores; honored only if it
  // is in the user's own brand set, otherwise the primary brand is used. ----
  const brandId = resolveBrandId(ctx, new URL(req.url).searchParams.get("brand_id"));
  if (!brandId) {
    return NextResponse.json(
      { error: "NO_BRAND_LINKED", message: "No brand is linked to your account yet." },
      { status: 400 }
    );
  }

  try {
    const baseUrl = process.env.INGESTION_API_BASE_URL?.trim() || "http://localhost:8080";
    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/billing/subscription`;

    const url = new URL(endpoint);
    url.searchParams.set("brand_id", brandId);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `[BILLING SUBSCRIPTION ERROR] FastAPI ${res.status} at ${endpoint}:`,
        JSON.stringify(body)
      );
    }
    return NextResponse.json(body, { status: res.status });
  } catch (err: any) {
    console.error("[BILLING SUBSCRIPTION ERROR] Network call failed:", err?.message || err);
    return NextResponse.json(
      { error: "SUBSCRIPTION_FETCH_FAILED", message: err?.message || String(err) },
      { status: 500 }
    );
  }
}