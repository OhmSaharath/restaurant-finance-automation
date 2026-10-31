import { NextResponse, NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";

const PAGE_SIZE = 500;

function parseDateParam(value: string | null, fallback: string): string {
  if (!value) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  return value;
}

export async function GET(req: NextRequest) {
  const rl = checkRateLimit(req, { max: 120, windowMs: 60_000, keyPrefix: "analytics-overview" });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please retry later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfterMs ?? 60_000) / 1000)) } }
    );
  }

  try {
    const ctx = await getTenantUserContext();
    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const requestedBrand = searchParams.get("brand_id");
    const brandIds = ctx.brandIds?.length
      ? ctx.brandIds
      : ctx.brandId ? [ctx.brandId] : [];

    if (!brandIds.length) {
      return NextResponse.json(
        { error: "NO_BRAND_SCOPE", message: "no brand linked" },
        { status: 401 }
      );
    }

    const isSingleBrand =
      !!requestedBrand && requestedBrand !== "ALL" && brandIds.includes(requestedBrand);

    const nowUtc7 = new Date(Date.now() + 7 * 3600 * 1000);
    const defaultEnd = nowUtc7.toISOString().slice(0, 10);
    const defaultStart = new Date(nowUtc7.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
    const startDate = parseDateParam(searchParams.get("start_date"), defaultStart);
    const endDate = parseDateParam(searchParams.get("end_date"), defaultEnd);
    if (startDate > endDate) {
      return NextResponse.json(
        { error: "start_date must be <= end_date" },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    const data: any[] = [];
    let offset = 0;
    while (true) {
      let query = supabase
        .from("daily_reports")
        .select("id, report_date, gross_sales, deductions, net_sale, order_count, branches!inner(brand_id)")
        .gte("report_date", startDate)
        .lte("report_date", endDate)
        .eq("branches.is_active", true);

      if (isSingleBrand) {
        query = query.eq("branches.brand_id", requestedBrand);
      } else {
        query = query.in("branches.brand_id", brandIds);
      }

      const { data: page, error } = await query
        .order("report_date", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      const rows = page || [];
      data.push(...rows);
      if (rows.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    let totalGross = 0;
    let totalDeductions = 0;
    let totalNetPayout = 0;
    let totalOrders = 0;
    for (const row of data) {
      totalGross += parseFloat(row.gross_sales || "0");
      totalDeductions += parseFloat(row.deductions || "0");
      totalNetPayout += parseFloat(row.net_sale || "0");
      totalOrders += parseInt(row.order_count || "0", 10);
    }

    const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

    return NextResponse.json(
      {
        success: true,
        brand_id: isSingleBrand ? requestedBrand : "ALL",
        range: { start_date: startDate, end_date: endDate },
        report_count: data.length,
        total_gross: round2(totalGross),
        total_deductions: round2(totalDeductions),
        total_net_payout: round2(totalNetPayout),
        total_orders: totalOrders,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message || String(err) }, { status: 500 });
  }
}
