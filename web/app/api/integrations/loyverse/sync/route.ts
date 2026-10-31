import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext, hasWorkspaceWriteAccess, resolveBrandId } from "@/lib/auth";

/**
 * POST /api/integrations/loyverse/sync
 * Pull Loyverse now: forwards a sync trigger to the FastAPI integration service
 * (POST /api/v1/integrations/loyverse/sync), which pulls the storefront
 * (in-store) sales for the resolved tenant brand over Loyverse's default
 * 31-day window and persists it idempotently.
 *
 * This proxy is a thin passthrough — the endpoint takes no date range; it
 * pulls whatever Loyverse returns (31-day window). The full payload sent is
 * just { brand_id }, and the FastAPI JSON + status are returned verbatim.
 *
 * SECURITY:
 *  - Tenant brand is resolved server-side via resolveBrandId + membership;
 *    the client can never choose a foreign brand.
 *  - Uses the live Supabase session access token as the Bearer credential
 *    (FastAPI authenticates via JWKS). The token is never logged or returned.
 *  - Strict per-brand rate limit: 5 sync requests per hour.
 *  - Never reads or returns the refresh/token secret.
 */

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

/**
 * Return shape we care about for the success toast (kept optional / defensive
 * so we render whatever FastAPI actually returns).
 */
interface LoyverseSyncResult {
  total_receipts_ingested?: number;
  rows_upserted?: number;
  receipts_skipped_refund?: number;
  note_31day_history?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ---- Auth: must be an authenticated tenant user ----
  const ctx = await getTenantUserContext();
  if (!ctx || !ctx.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasWorkspaceWriteAccess(ctx)) {
    return NextResponse.json({ error: "PARTNER_READ_ONLY" }, { status: 403 });
  }

  // ---- Resolve tenant brand (server-side; membership-checked) ----
  let requestedBrand: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body === "object" && typeof (body as any).brand_id === "string") {
      requestedBrand = (body as any).brand_id as string;
    }
  } catch {
    requestedBrand = null;
  }
  const brandId = resolveBrandId(ctx, requestedBrand);
  if (!brandId) {
    return NextResponse.json({ error: "NO_TENANT_BRAND" }, { status: 403 });
  }

  // ---- Strict per-brand rate limit: 5 sync requests / hour / brand ----
  const now = Date.now();
  let bucket = rateBuckets.get(brandId);
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    rateBuckets.set(brandId, bucket);
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((bucket.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Max 5 sync requests per hour per brand." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }
  bucket.count += 1;

  // ---- Live session access token: FastAPI authenticates with the user's
  // Supabase access token (JWT via JWKS), not a shared key. ----
  const supabase = await createClient();
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const sessionAccessToken = sessionData?.session?.access_token;
  if (sessionError || !sessionAccessToken) {
    return NextResponse.json(
      { error: "NO_SESSION_TOKEN", message: "No live Supabase session access token available." },
      { status: 401 }
    );
  }

  // ---- Forward to FastAPI. Body carries ONLY brand_id (no date range). ----
  const baseUrl = process.env.INGESTION_API_BASE_URL?.trim() || "http://localhost:8080";
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/integrations/loyverse/sync`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionAccessToken}`,
      },
      body: JSON.stringify({ brand_id: brandId }),
    });

    const body = (await res.json().catch(() => ({}))) as LoyverseSyncResult;
    // Return the FastAPI JSON + status verbatim (never echo the access token).
    return NextResponse.json(body, { status: res.status });
  } catch (err: any) {
    // Network failure: surface { error, message } only — never the token.
    return NextResponse.json(
      { error: "SYNC_FORWARD_FAILED", message: err?.message || String(err) },
      { status: 502 }
    );
  }
}
