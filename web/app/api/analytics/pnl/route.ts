import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext, resolveBrandId } from "@/lib/auth";

/**
 * GET /api/analytics/pnl
 * Tenant proxy for the consolidated Multi-Branch P&L + financial reconciliation
 * summary. Resolves brand_id SERVER-SIDE (a client-selected store is honored
 * ONLY if it is in the user's own brand set) and forwards to
 * `${INGESTION_API_BASE_URL}/api/v1/analytics/pnl` with the user's LIVE
 * Supabase access token as `Authorization: Bearer *** (FastAPI verifies the
 * JWT via JWKS and membership-checks brand_id).
 *
 * SECURITY: tenant session required (401); brand_id resolved via resolveBrandId
 * (client-selected brand honored ONLY if it is in the user's own brand set, else
 * the primary brand; 400 NO_BRAND_LINKED if none); fixed-window rate limit
 * (10/min/IP); env secrets.
 */

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;

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

function parseDateParam(value: string | null, fallback: string): string {
  if (!value) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  return value;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rl = rateLimit(req);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please retry later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfterMs ?? 60_000) / 1000)) } }
    );
  }

  const ctx = await getTenantUserContext();
  if (!ctx || !ctx.userId) {
    return NextResponse.json({ error: "UNAUTHORIZED", message: "Please sign in." }, { status: 401 });
  }

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  if (!accessToken) {
    return NextResponse.json({ error: "UNAUTHORIZED", message: "Please sign in." }, { status: 401 });
  }

  const brandId = resolveBrandId(ctx, new URL(req.url).searchParams.get("brand_id"));
  if (!brandId) {
    return NextResponse.json(
      { error: "NO_BRAND_LINKED", message: "No brand is linked to your account yet." },
      { status: 400 }
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const nowUtc7 = new Date(Date.now() + 7 * 3600 * 1000);
    const defaultEnd = nowUtc7.toISOString().slice(0, 10);
    const defaultStart = new Date(nowUtc7.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
    const startDate = parseDateParam(searchParams.get("start_date"), defaultStart);
    const endDate = parseDateParam(searchParams.get("end_date"), defaultEnd);
    const branchId = searchParams.get("branch_id") || "";
    const cogsRatio = searchParams.get("cogs_ratio") || "";

    const baseUrl = process.env.INGESTION_API_BASE_URL?.trim() || "http://localhost:8080";
    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/analytics/pnl`;

    const url = new URL(endpoint);
    url.searchParams.set("brand_id", brandId);
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("end_date", endDate);
    if (branchId) url.searchParams.set("branch_id", branchId);
    if (cogsRatio) url.searchParams.set("cogs_ratio", cogsRatio);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `[PNL ERROR] FastAPI ${res.status} at ${endpoint}:`,
        JSON.stringify(body)
      );
    }
    return NextResponse.json(body, { status: res.status });
  } catch (err: any) {
    console.error("[PNL ERROR] Network call failed:", err?.message || err);
    return NextResponse.json(
      { error: "PNL_FETCH_FAILED", message: err?.message || String(err) },
      { status: 500 }
    );
  }
}