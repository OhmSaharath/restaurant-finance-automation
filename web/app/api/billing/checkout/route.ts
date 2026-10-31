import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext, hasWorkspaceWriteAccess, resolveBrandId } from "@/lib/auth";

/**
 * POST /api/billing/checkout
 * Tenant proxy to start a Stripe Checkout session.
 *
 * Resolves the tenant brand_id SERVER-SIDE from the authenticated session
 * (a client-selected store is honored ONLY if it is in the user's own brand
 * set), then forwards to `${INGESTION_API_BASE_URL}/api/v1/billing/checkout`
 * with the user's LIVE Supabase access token as `Authorization: Bearer ***
 * (FastAPI verifies the JWT via JWKS and membership-checks brand_id). The
 * success/cancel URLs are derived from the request origin so the redirect
 * lands back on /billing in local dev and production alike. The backend
 * returns `{ url }`; the frontend redirects there.
 *
 * SECURITY:
 *  - Tenant session required (getTenantUserContext + live token) — 401.
 *  - brand_id never trusted from the client — resolved via resolveBrandId: a
 *    tenant session without a linked brand gets 400 NO_BRAND_LINKED.
 *  - Fixed-window in-memory rate limit (10/min/IP), matching costs/scan.
 *  - Secrets come from env only; no API key is used or logged.
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

export async function POST(req: NextRequest): Promise<NextResponse> {
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
  if (!hasWorkspaceWriteAccess(ctx)) {
    return NextResponse.json(
      { error: "PARTNER_READ_ONLY", message: "Partner accounts cannot change billing." },
      { status: 403 }
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

  // ---- Resolve brand_id server-side with a membership check (never trust a
  // non-member client brand). The client may OPTIONALLY send brand_id in the
  // JSON body to select one of THEIR stores; it is honored only if it is in the
  // authenticated user's own brand set, otherwise the primary brand is used. ----
  const requestedBrand = await req
    .json()
    .then((b: any) => (typeof b?.brand_id === "string" ? b.brand_id : null))
    .catch(() => null);
  const brandId = resolveBrandId(ctx, requestedBrand);
  if (!brandId) {
    return NextResponse.json(
      { error: "NO_BRAND_LINKED", message: "No brand is linked to your account yet." },
      { status: 400 }
    );
  }

  // ---- Derive redirect URLs from the request origin (local + prod safe) ----
  const origin = req.headers.get("origin")?.trim() || req.nextUrl.origin;
  const baseOrigin = origin.replace(/\/+$/, "");
  const successUrl = `${baseOrigin}/billing?checkout=success`;
  const cancelUrl = `${baseOrigin}/billing?checkout=cancel`;

  try {
    const baseUrl = process.env.INGESTION_API_BASE_URL?.trim() || "http://localhost:8080";
    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/billing/checkout`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ brand_id: brandId, success_url: successUrl, cancel_url: cancelUrl }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `[BILLING CHECKOUT ERROR] FastAPI ${res.status} at ${endpoint}:`,
        JSON.stringify(body)
      );
    }
    return NextResponse.json(body, { status: res.status });
  } catch (err: any) {
    console.error("[BILLING CHECKOUT ERROR] Network call failed:", err?.message || err);
    return NextResponse.json(
      { error: "CHECKOUT_FAILED", message: err?.message || String(err) },
      { status: 500 }
    );
  }
}
