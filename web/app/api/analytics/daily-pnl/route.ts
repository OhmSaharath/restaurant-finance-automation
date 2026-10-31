import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";

function parseDateParam(value: string | null, fallback: string): string {
  if (!value) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  return value;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rl = checkRateLimit(req, { max: 10, windowMs: 60_000, keyPrefix: "analytics-daily-pnl" });
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

  const requestedBrandId = new URL(req.url).searchParams.get("brand_id");
  const tenantBrandIds = ctx.brandIds?.length ? ctx.brandIds : ctx.brandId ? [ctx.brandId] : [];
  if (!tenantBrandIds.length) {
    return NextResponse.json(
      { error: "NO_BRAND_LINKED", message: "No brand is linked to your account yet." },
      { status: 400 }
    );
  }
  const isAllBrands = !requestedBrandId || requestedBrandId === "ALL";
  if (!isAllBrands && !tenantBrandIds.includes(requestedBrandId)) {
    return NextResponse.json(
      { error: "BRAND_NOT_IN_SCOPE", message: "Requested brand_id is not a member of your tenant scope." },
      { status: 403 }
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

    const baseUrl = process.env.INGESTION_API_BASE_URL?.trim() || "http://localhost:8080";
    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/analytics/daily-pnl`;

    const url = new URL(endpoint);
    if (!isAllBrands) url.searchParams.set("brand_id", requestedBrandId as string);
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("end_date", endDate);
    if (branchId) url.searchParams.set("branch_id", branchId);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `[DAILY PNL ERROR] FastAPI ${res.status} at ${endpoint}:`,
        JSON.stringify(body)
      );
    }
    return NextResponse.json(body, { status: res.status });
  } catch (err: any) {
    console.error("[DAILY PNL ERROR] Network call failed:", err?.message || err);
    return NextResponse.json(
      { error: "DAILY_PNL_FETCH_FAILED", message: err?.message || String(err) },
      { status: 500 }
    );
  }
}
