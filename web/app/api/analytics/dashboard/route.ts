import { NextResponse, NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext, resolveBrandId } from "@/lib/auth";
import { parseFinancialDetails } from "@/lib/utils";
import { checkRateLimit } from "@/lib/rate-limit";

const PAGE_SIZE = 500;

function parseDateParam(value: string | null, fallback: string): string {
  if (!value) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  return value;
}

const PLATFORM_KEY: Record<string, string> = {
  "LINE MAN": "line_man",
  Grab: "grab",
  "Shopee Food": "shopee_food",
  Robinhood: "robinhood",
};

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

export async function GET(req: NextRequest) {
  const rl = checkRateLimit(req, { max: 120, windowMs: 60_000, keyPrefix: "analytics-dashboard" });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please retry later." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil((rl.retryAfterMs ?? 60_000) / 1000)) },
      }
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

    const brandId = resolveBrandId(ctx, requestedBrand);
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

    const rows: any[] = [];
    let offset = 0;
    while (true) {
      let query = supabase
        .from("daily_reports")
        .select(
          "id, report_date, platform, order_count, gross_sales, deductions, net_sale, details, branches!inner(brand_id)"
        )
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
      const batch = page || [];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    let totalGross = 0;
    let totalDeductions = 0;
    let totalNetPayout = 0;
    let totalOrders = 0;
    for (const row of rows) {
      totalGross += parseFloat(row.gross_sales || "0");
      totalDeductions += parseFloat(row.deductions || "0");
      totalNetPayout += parseFloat(row.net_sale || "0");
      totalOrders += parseInt(row.order_count || "0", 10);
    }

    const daily = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const date = String(row.report_date || "");
      if (!date) continue;
      const entry = daily.get(date) || {
        line_man: 0,
        grab: 0,
        shopee_food: 0,
        robinhood: 0,
        other: 0,
        total_gross: 0,
      };
      const gross = parseFloat(row.gross_sales || "0");
      const platform = String(row.platform || "");
      const bucket = PLATFORM_KEY[platform] || "other";
      entry[bucket] += gross;
      entry.total_gross += gross;
      daily.set(date, entry);
    }
    const dailyByPlatform = Array.from(daily.entries())
      .map(([date, e]) => ({
        date,
        line_man: round2(e.line_man),
        grab: round2(e.grab),
        shopee_food: round2(e.shopee_food),
        robinhood: round2(e.robinhood),
        other: round2(e.other),
        total_gross: round2(e.total_gross),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    let gpCommission = 0;
    let vatOnGp = 0;
    let merchantPromos = 0;
    let adMarketing = 0;
    let otherDeductions = 0;
    for (const row of rows) {
      const parsed = parseFinancialDetails(String(row.platform || ""), row.details);
      gpCommission += parsed.deductions.gp;
      vatOnGp += parsed.deductions.vat;
      merchantPromos += parsed.deductions.promos;
      adMarketing += parsed.deductions.ads;
      otherDeductions += parsed.deductions.other;
    }
    const totalDeductionsDecomp =
      gpCommission + vatOnGp + merchantPromos + adMarketing + otherDeductions;
    const takeRatePct = totalGross > 0 ? (totalDeductions / totalGross) * 100 : 0;

    return NextResponse.json(
      {
        success: true,
        brand_id: brandId,
        range: { start_date: startDate, end_date: endDate },
        report_count: rows.length,
        total_gross: round2(totalGross),
        total_deductions: round2(totalDeductions),
        total_net_payout: round2(totalNetPayout),
        total_orders: totalOrders,
        daily_by_platform: dailyByPlatform,
        deduction_decomposition: {
          gp_commission: round2(gpCommission),
          vat_on_gp: round2(vatOnGp),
          merchant_promos: round2(merchantPromos),
          ad_marketing: round2(adMarketing),
          other_deductions: round2(otherDeductions),
          total_deductions: round2(totalDeductionsDecomp),
          take_rate_pct: round2(takeRatePct),
        },
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message || String(err) }, { status: 500 });
  }
}
