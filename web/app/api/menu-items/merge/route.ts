import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext, resolveBrandId } from "@/lib/auth";

/**
 * POST /api/menu-items/merge
 * Tenant proxy for the FastAPI menu-items merge endpoint.
 *
 * The browser sends `{ primary_id, merge_ids }` (selected checkboxes only).
 * This route NEVER trusts a client-supplied brand_id — it resolves `brand_id`
 * server-side from the authenticated tenant session and forwards
 * `{ brand_id, primary_id, merge_ids }` to
 * `${INGESTION_API_BASE_URL}/api/v1/menu-items/merge` with the user's LIVE
 * Supabase access token as `Authorization: Bearer *** (FastAPI verifies the
 * JWT via JWKS and membership-checks brand_id). The FastAPI side then
 * re-verifies every menu_item belongs to that brand before repointing
 * sales/mappings and deleting.
 *
 * SECURITY:
 *  - Tenant session required (getTenantUserContext + live token) — 401.
 *  - Fixed-window in-memory rate limit (max 10 merges/min/IP), the same style
 *    as web/app/api/costs/scan/route.ts.
 *  - Secrets come from env only; no API key is used or logged.
 */

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;

// Fixed-window rate limiter (in-memory, single-instance; sufficient for this route).
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

  // ---- Auth: require a tenant session with a brand ----
  const ctx = await getTenantUserContext();
  if (!ctx || !ctx.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { primary_id?: unknown; merge_ids?: unknown; brand_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "INVALID_JSON", message: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  // Resolve brand_id server-side with a membership check. The client may
  // OPTIONALLY send brand_id in the JSON body to select one of THEIR stores;
  // honored only if in the user's own brand set, otherwise the primary brand.
  const requestedBrand = typeof body.brand_id === "string" ? body.brand_id : null;
  const brandId = resolveBrandId(ctx, requestedBrand);
  if (!brandId) {
    return NextResponse.json(
      { error: "NO_BRAND", message: "No tenant brand is linked to your account." },
      { status: 400 }
    );
  }

  const primaryId = typeof body.primary_id === "string" ? body.primary_id.trim() : "";
  const rawMerge = Array.isArray(body.merge_ids) ? body.merge_ids : [];
  const mergeIds = rawMerge
    .filter((m) => typeof m === "string" && m.trim() !== "")
    .map((m) => (m as string).trim());

  if (!primaryId) {
    return NextResponse.json(
      { error: "MISSING_PRIMARY", message: "primary_id is required." },
      { status: 400 }
    );
  }
  if (mergeIds.length === 0) {
    return NextResponse.json(
      { error: "EMPTY_MERGE", message: "merge_ids must contain at least one item." },
      { status: 400 }
    );
  }
  if (mergeIds.includes(primaryId)) {
    return NextResponse.json(
      { error: "PRIMARY_IN_MERGE", message: "primary_id must not be in merge_ids." },
      { status: 400 }
    );
  }

  // Live Supabase access token for JWT auth upstream (ES256 / JWKS).
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const baseUrl = process.env.INGESTION_API_BASE_URL?.trim() || "http://localhost:8080";
    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/menu-items/merge`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        brand_id: brandId,
        primary_id: primaryId,
        merge_ids: mergeIds,
      }),
    });

    const resBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `[MENU ITEMS MERGE ERROR] FastAPI ${res.status} at ${endpoint}:`,
        JSON.stringify(resBody)
      );
    }
    return NextResponse.json(resBody, { status: res.status });
  } catch (err: any) {
    console.error("[MENU ITEMS MERGE ERROR] Network call failed:", err?.message || err);
    return NextResponse.json(
      { error: "MERGE_FAILED", message: err?.message || String(err) },
      { status: 500 }
    );
  }
}