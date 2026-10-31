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

/**
 * GET /api/analytics/branches
 * Live, tenant-isolated per-branch aggregation of daily_reports for the dashboard
 * Branch Liquidity Card Deck. This is the single source of truth for branch-level
 * liquidity figures — NO hardcoded ground-truth numbers are ever rendered here.
 */
export async function GET(req: NextRequest) {
  const rl = checkRateLimit(req, { max: 120, windowMs: 60_000, keyPrefix: "analytics-branches" });
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

    // Default window: trailing 30 days through today (UTC+7 Thailand).
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

    // Session-scoped (RLS) client — never a standalone Service Role client.
    const supabase = await createClient();

    // Paginate daily_reports across PostgREST pages so >1,000 rows are never truncated.
    const data: any[] = [];
    let offset = 0;
    while (true) {
      let query = supabase
        .from("daily_reports")
        .select(
          "id, platform, gross_sales, deductions, net_sale, order_count, branches!inner(id, branch_code, branch_name, brand_id, brands(id, name))"
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
      const rows = page || [];
      data.push(...rows);
      if (rows.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    // Paginate daily_item_sales across PostgREST pages.
    const itemizedRows: any[] = [];
    let itemOffset = 0;
    while (true) {
      let itemizedQuery = supabase
        .from("daily_item_sales")
        .select("id, branch_id, platform, quantity, menu_items(cost)")
        .gte("report_date", startDate)
        .lte("report_date", endDate);

      if (isSingleBrand) {
        itemizedQuery = itemizedQuery.eq("brand_id", requestedBrand);
      } else {
        itemizedQuery = itemizedQuery.in("brand_id", brandIds);
      }

      const { data: itemPage, error: itemizedError } = await itemizedQuery
        .order("report_date", { ascending: true })
        .order("id", { ascending: true })
        .range(itemOffset, itemOffset + PAGE_SIZE - 1);

      if (itemizedError) {
        console.warn("daily_item_sales read failed:", itemizedError.message);
        break;
      }
      const rows = itemPage || [];
      itemizedRows.push(...rows);
      if (rows.length < PAGE_SIZE) break;
      itemOffset += PAGE_SIZE;
    }

    // --- Coverage-aware COGS aggregation over the itemized rows ---
    const COGS_RATIO = 0.32;
    let totalItemizedCogs = 0;
    const coveredPlatforms = new Set<string>();
    const itemizedCogsByBranch = new Map<string, number>();
    const coveredPlatformsByBranch = new Map<string, Set<string>>();
    let hasItemizedRows = false;
    for (const irow of itemizedRows) {
      const platform = String(irow.platform || "");
      const miRaw: any = irow.menu_items;
      const mi = Array.isArray(miRaw) ? miRaw[0] : miRaw;
      const cost = mi?.cost == null ? null : parseFloat(mi.cost);
      const qty = irow.quantity == null ? null : parseFloat(irow.quantity);
      if (cost == null || qty == null || isNaN(cost) || isNaN(qty)) continue;
      const cogs = cost * qty;
      hasItemizedRows = true;
      if (platform) coveredPlatforms.add(platform);
      totalItemizedCogs += cogs;
      if (irow.branch_id) {
        const bid = String(irow.branch_id);
        itemizedCogsByBranch.set(bid, (itemizedCogsByBranch.get(bid) || 0) + cogs);
        if (platform) {
          let bSet = coveredPlatformsByBranch.get(bid);
          if (!bSet) {
            bSet = new Set<string>();
            coveredPlatformsByBranch.set(bid, bSet);
          }
          bSet.add(platform);
        }
      }
    }

    const byBranch = new Map<
      string,
      {
        branch_id: string;
        branch_code: string;
        branch_name: string;
        brand_id: string;
        brand_name: string;
        total_gross: number;
        total_deductions: number;
        total_net_payout: number;
        total_orders: number;
        platformGross: Record<string, number>;
      }
    >();
    const totalGrossByPlatform: Record<string, number> = {};

    for (const rawRow of data) {
      const row: any = rawRow;
      const brRaw = row.branches;
      const br = Array.isArray(brRaw) ? brRaw[0] : brRaw;
      if (!br || !br.id) continue;
      const key = String(br.id);
      const brandsRaw = br.brands;
      const brandObj = Array.isArray(brandsRaw) ? brandsRaw[0] : brandsRaw;
      const agg = byBranch.get(key) || {
        branch_id: key,
        branch_code: br.branch_code || "",
        branch_name: br.branch_name || "",
        brand_id: br.brand_id ? String(br.brand_id) : "",
        brand_name: brandObj?.name ? String(brandObj.name) : "",
        total_gross: 0,
        total_deductions: 0,
        total_net_payout: 0,
        total_orders: 0,
        platformGross: {} as Record<string, number>,
      };
      agg.total_gross += parseFloat(row.gross_sales || "0");
      agg.total_deductions += parseFloat(row.deductions || "0");
      agg.total_net_payout += parseFloat(row.net_sale || "0");
      agg.total_orders += parseInt(row.order_count || "0", 10);
      const platform = String(row.platform || "");
      if (platform) {
        agg.platformGross[platform] =
          (agg.platformGross[platform] || 0) + parseFloat(row.gross_sales || "0");
        totalGrossByPlatform[platform] =
          (totalGrossByPlatform[platform] || 0) + parseFloat(row.gross_sales || "0");
      }
      byBranch.set(key, agg);
    }

    const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

    let totalCogs: number;
    let cogsIsEstimated = false;
    if (hasItemizedRows) {
      let uncoveredGross = 0;
      for (const [platform, gross] of Object.entries(totalGrossByPlatform)) {
        if (!coveredPlatforms.has(platform)) uncoveredGross += gross;
      }
      cogsIsEstimated = uncoveredGross > 0;
      totalCogs = totalItemizedCogs + COGS_RATIO * uncoveredGross;
    } else {
      let grossAll = 0;
      for (const g of Object.values(totalGrossByPlatform)) grossAll += g;
      cogsIsEstimated = grossAll > 0;
      totalCogs = COGS_RATIO * grossAll;
    }
    const totalGrossAll = Object.values(totalGrossByPlatform).reduce((a, b) => a + b, 0);
    const foodCostPct = totalGrossAll > 0 ? (totalCogs / totalGrossAll) * 100 : 0;

    const branches = Array.from(byBranch.values())
      .map((agg) => {
        let dominantPlatform = "";
        let maxGross = -1;
        for (const [platform, gross] of Object.entries(agg.platformGross)) {
          if (gross > maxGross) {
            maxGross = gross;
            dominantPlatform = platform;
          }
        }
        // Per-branch COGS: REAL itemized COGS for platforms covered on this branch,
        // plus 32% fallback for any platform on this branch that has no itemized COGS
        // (including LINE MAN all-branches rows or any uncovered delivery channel).
        let branchCogs: number;
        if (hasItemizedRows) {
          const bItemized = itemizedCogsByBranch.get(agg.branch_id) || 0;
          const bCovered = coveredPlatformsByBranch.get(agg.branch_id) || new Set<string>();
          let bUncoveredGross = 0;
          for (const [platform, gross] of Object.entries(agg.platformGross)) {
            if (!bCovered.has(platform)) {
              bUncoveredGross += gross;
            }
          }
          branchCogs = bItemized + COGS_RATIO * bUncoveredGross;
        } else {
          branchCogs = COGS_RATIO * agg.total_gross;
        }
        return {
          branch_id: agg.branch_id,
          branch_code: agg.branch_code,
          branch_name: agg.branch_name,
          brand_id: agg.brand_id,
          brand_name: agg.brand_name,
          total_gross: round2(agg.total_gross),
          total_deductions: round2(agg.total_deductions),
          total_net_payout: round2(agg.total_net_payout),
          total_orders: agg.total_orders,
          dominant_platform: dominantPlatform,
          cogs: round2(branchCogs),
        };
      })
      .sort((a, b) => (b.total_gross as number) - (a.total_gross as number));

    let totalDeductionsAll = 0;
    let totalNetAll = 0;
    let totalOrdersAll = 0;
    for (const agg of byBranch.values()) {
      totalDeductionsAll += agg.total_deductions;
      totalNetAll += agg.total_net_payout;
      totalOrdersAll += agg.total_orders;
    }

    const { data: brandRows } = await supabase
      .from("brands")
      .select("id, name")
      .in("id", brandIds);
    const brands: Array<{ id: string; name: string }> = (brandRows || []).map(
      (br: any) => ({
        id: String(br.id),
        name: String(br.name || ""),
      })
    );

    return NextResponse.json(
      {
        success: true,
        brand_id: isSingleBrand ? requestedBrand : "ALL",
        range: { start_date: startDate, end_date: endDate },
        report_count: data.length,
        branch_count: branches.length,
        total_gross: round2(totalGrossAll),
        total_deductions: round2(totalDeductionsAll),
        total_net_payout: round2(totalNetAll),
        total_orders: totalOrdersAll,
        total_cogs: round2(totalCogs),
        cogs_is_estimated: cogsIsEstimated,
        food_cost_pct: round2(foodCostPct),
        branches,
        brands,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message || String(err) }, { status: 500 });
  }
}
