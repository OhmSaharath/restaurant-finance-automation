import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext } from "@/lib/auth";

/**
 * POST /api/menu-sales/scan
 * Tenant proxy for the FastAPI menu-sales scan endpoint.
 *
 * Accepts a multipart file upload (plus platform) from the browser and forwards
 * it to `${INGESTION_API_BASE_URL}/api/v1/menu-sales/scan` with the user's LIVE
 * Supabase access token as `Authorization: Bearer *** FastAPI verifies the JWT
 * (ES256 via JWKS), extracts the real user_id, and derives the tenant scope
 * from brand_users — so this proxy forwards NO brand_id / user_id /
 * tenant_brand_ids, and a client can never forge a tenant.
 *
 * TENANT ISOLATION (CRITICAL):
 *  - The tenant brand is derived UPSTREAM (FastAPI) from the verified JWT's
 *    `sub` against brand_users. getTenantUserContext still guards that the
 *    session has a linked brand (server-side) — 400 if none.
 *
 * SECURITY:
 *  - Tenant session required (getTenantUserContext + live session token) — 401.
 *  - Fixed-window in-memory rate limit (max 10 scans/min/IP).
 *  - Secrets come from env only (INGESTION_API_BASE_URL); nothing secret is
 *    logged and no API key is used.
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

  // ---- Auth: require a tenant session ----
  const ctx = await getTenantUserContext();
  if (!ctx || !ctx.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ---- Tenant isolation guard (server-side, symmetric with FastAPI's JWT
  // scope): the session already has a linked brand — 400 if none. ----
  if (!ctx.brandId) {
    return NextResponse.json(
      { error: "NO_BRAND_LINKED", message: "no brand linked" },
      { status: 400 }
    );
  }

  // Live Supabase access token for JWT auth upstream (ES256 / JWKS). This is the
  // user's own session token — FastAPI verifies it and derives the tenant scope
  // server-side; this proxy forwards NO brand_id / user_id / tenant_brand_ids.
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const uploaded = formData
      .getAll("files")
      .filter((v): v is File => typeof v !== "string");
    const platform = formData.get("platform");
    if (!uploaded.length) {
      return NextResponse.json(
        { error: "NO_FILE", message: "Missing 'files' field in the multipart upload." },
        { status: 400 }
      );
    }
    const platformValue =
      typeof platform === "string" && (platform === "Grab" || platform === "LINE MAN")
        ? platform
        : "";

    const baseUrl = process.env.INGESTION_API_BASE_URL?.trim() || "http://localhost:8080";
    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/menu-sales/scan`;

    const outForm = new FormData();
    for (const f of uploaded) {
      outForm.append("files", f, f.name || "menu-sales.csv");
    }
    outForm.append("platform", platformValue);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: outForm,
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `[MENU-SALES SCAN ERROR] FastAPI ${res.status} at ${endpoint}:`,
        JSON.stringify(body)
      );
    }
    return NextResponse.json(body, { status: res.status });
  } catch (err: any) {
    console.error("[MENU-SALES SCAN ERROR] Network call failed:", err?.message || err);
    return NextResponse.json(
      { error: "SCAN_FAILED", message: err?.message || String(err) },
      { status: 500 }
    );
  }
}