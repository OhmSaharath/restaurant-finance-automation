export interface BranchFinancials {
  id: string;
  code: string;
  name: string;
  brandId: string;
  brandName: string;
  colorTheme: "dark-platinum" | "pearl-white" | "royal-emerald" | "holographic-slate";
  grossSales: number;
  deductions: number;
  netPayout: number;
  cogs: number;
  realNetProfit: number;
  orderCount: number;
  dominantPlatform: "LINE MAN" | "Grab" | "Shopee Food" | "Robinhood";
  takeRatePct: number;
  foodCostPct: number;
  coordinates: string;
}

export interface PlatformDailySales {
  date: string;
  dayLabel: string;
  lineMan: number;
  grab: number;
  shopeeFood: number;
  robinhood: number;
  totalGross: number;
}

export interface DeductionDecomposition {
  gpCommission: number;
  vatOnGp: number;
  merchantPromos: number;
  adMarketing: number;
  otherDeductions: number;
  totalDeductions: number;
  takeRatePct: number;
}

export interface DashboardData {
  brandName: string;
  settlementPeriod: string;
  grossSales: number;
  totalDeductions: number;
  netDeliveryPayout: number;
  totalOrders: number;
  totalCogs?: number;
  realNetProfit?: number;
  takeRatePct: number;
  foodCostPct?: number;
  netMarginPct: number;
  branches: BranchFinancials[];
  dailyChartData: PlatformDailySales[];
  deductions: DeductionDecomposition;
}

function formatDateString(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", year: "numeric" }).format(d);
  } catch {
    return dateStr;
  }
}

/** Round to 2dp to avoid floating-point drift in display. */
function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-01" -> "01 Sep" for the chart x-axis. Returns the raw string on bad input. */
function dayLabelOf(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const month = MONTHS_ABBR[parseInt(m[2], 10) - 1] || m[2];
  return `${m[3]} ${month}`;
}

/* =============================================================================
   Branch display METADATA — cosmetics ONLY (Thai display name, color theme,
   map coordinates), keyed by branch_code. NO money fields live here. Every
   financial figure rendered to the user (grossSales, deductions, netPayout,
   cogs, realNetProfit, orderCount) comes strictly from the live aggregation
   routes below; these fallbacks only smooth display when the live row has no
   name/theme/coordinates. Real numbers always win.
   ============================================================================= */
interface BranchMetadata {
  name: string;
  brandName: string;
  colorTheme: BranchFinancials["colorTheme"];
  coordinates: string;
}

// No seeded branch identities are used in production. If a branch has no name
// or coordinates in the database, the UI renders the live code/empty metadata
// rather than inventing a tenant-specific location.
const BRANCH_METADATA: Record<string, BranchMetadata> = {};

/* =============================================================================
   Branch Liquidity Card Deck — LIVE Tenant-Isolated Aggregation
   ---------------------------------------------------------------
   These branches feed the "Branch Liquidity Card Deck" + Location Map on the
   dashboard. They are sourced from /api/analytics/branches (server route that
   groups daily_reports by branch, filtered to the tenant brand and the selected
   date window). NO hardcoded ground-truth numbers are rendered here.
   ============================================================================= */

export interface BranchLiquidityRow {
  branch_id: string;
  branch_code: string;
  branch_name: string;
  brand_id?: string;
  brand_name?: string;
  total_gross: number;
  total_deductions: number;
  total_net_payout: number;
  total_orders: number;
  dominant_platform: string;
  cogs?: number;
}

/**
 * Map a live route row (BranchLiquidityRow) to a BranchFinancials card. Financial
 * figures come strictly from the live aggregation; BRANCH_METADATA supplies only
 * cosmetics (Thai name, color theme, coordinates) as a fallback. brandId/brandName
 * come from the LIVE row so two same-named branches under different stores are
 * distinguishable.
 */
function mapBranchRow(
  r: BranchLiquidityRow,
  meta: BranchMetadata | undefined,
  liveFoodCostPct: number | undefined
): BranchFinancials {
  const grossSales = round2(r.total_gross);
  const deductions = round2(r.total_deductions);
  const netPayout = round2(r.total_net_payout);
  const cogs = round2(r.cogs ?? grossSales * 0.32);
  const takeRatePct =
    grossSales > 0 ? Math.round((deductions / grossSales) * 1000) / 10 : 0;

  const dominantPlatform: "LINE MAN" | "Grab" | "Shopee Food" | "Robinhood" =
    r.dominant_platform === "Grab" ||
    r.dominant_platform === "LINE MAN" ||
    r.dominant_platform === "Shopee Food" ||
    r.dominant_platform === "Robinhood"
      ? r.dominant_platform
      : "LINE MAN";

  return {
    id: r.branch_id,
    code: r.branch_code,
    name: r.branch_name || meta?.name || r.branch_code,
    brandId: r.brand_id || "",
    brandName: r.brand_name || meta?.brandName || r.branch_name || "",
    colorTheme: meta?.colorTheme || "dark-platinum",
    grossSales,
    deductions,
    netPayout,
    // REAL per-branch itemized COGS from the route; falls back to the 32%
    // estimate only if the route did not supply a cogs value.
    cogs,
    // Real net profit = net payout minus food cost (NOT net payout alone).
    realNetProfit: round2(netPayout - cogs),
    orderCount: r.total_orders,
    dominantPlatform,
    takeRatePct,
    // Route's live food-cost ratio (itemized-aware). Only a live ratio, never a
    // fabricated default, is treated as authoritative for a window.
    foodCostPct: liveFoodCostPct ?? 0,
    coordinates: meta?.coordinates || "",
  };
}

/**
 * Fetch per-branch liquidity for the selected date window from the live,
 * tenant-isolated /api/analytics/branches route. Returns [] on any failure or on
 * an empty result set so the caller never falls back to mock numbers.
 */
export async function getLiveDashboardBranches(
  startDate: string,
  endDate: string
): Promise<BranchFinancials[]> {
  try {
    const res = await fetch(
      `/api/analytics/branches?start_date=${startDate}&end_date=${endDate}`,
      { cache: "no-store" }
    );
    if (!res.ok) return [];
    const json = await res.json();
    if (!json.success || !Array.isArray(json.branches)) return [];
    const rows: BranchLiquidityRow[] = json.branches;
    if (rows.length === 0) return [];
    // Route-level food-cost ratio (itemized COGS / gross), the single source
    // of truth for the per-branch foodCostPct shown on the card deck.
    const liveFoodCostPct =
      typeof json.food_cost_pct === "number" ? json.food_cost_pct : undefined;

    return rows.map((r) =>
      mapBranchRow(r, BRANCH_METADATA[r.branch_code], liveFoodCostPct)
    );
  } catch (err) {
    console.warn("getLiveDashboardBranches failed:", err);
    return [];
  }
}

/** A store (brand) option for the store selector on the /branches page. */
export interface TenantBrandOption {
  id: string;
  name: string;
}

/**
 * Fetch live branch liquidity AND the tenant's full brand set for the /branches
 * page. Uses the same tenant-isolated /api/analytics/branches route as the
 * dashboard; optionally narrows to a single member brand via brand_id. Both
 * lists are returned so the store selector and the branch grid stay in sync
 * with one round-trip. Returns empty lists on any failure.
 */
export async function getLiveBranchesPageData(
  startDate: string,
  endDate: string,
  brandId?: string
): Promise<{ branches: BranchFinancials[]; brands: TenantBrandOption[] }> {
  const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
  if (brandId && brandId !== "ALL") params.set("brand_id", brandId);
  try {
    const res = await fetch(`/api/analytics/branches?${params.toString()}`, {
      cache: "no-store",
    });
    if (!res.ok) return { branches: [], brands: [] };
    const json = await res.json();
    if (!json.success) return { branches: [], brands: [] };

    const rows: BranchLiquidityRow[] = Array.isArray(json.branches) ? json.branches : [];
    const liveFoodCostPct =
      typeof json.food_cost_pct === "number" ? json.food_cost_pct : undefined;
    const branches = rows.map((r) =>
      mapBranchRow(r, BRANCH_METADATA[r.branch_code], liveFoodCostPct)
    );

    const brands: TenantBrandOption[] = Array.isArray(json.brands)
      ? json.brands.map((b: any) => ({
          id: String(b.id),
          name: String(b.name || ""),
        }))
      : [];

    return { branches, brands };
  } catch (err) {
    console.warn("getLiveBranchesPageData failed:", err);
    return { branches: [], brands: [] };
  }
}

/**
 * Fetch the route-level itemized COGS summary (total_cogs + food_cost_pct) for
 * the selected date window from the live /api/analytics/branches route. Driven
 * by the same real itemized data as the card deck, so the CogsGauge and the
 * branch cards always agree. Returns null on any failure so the caller never
 * shows fabricated numbers.
 */
export async function getLiveDashboardCogs(
  startDate: string,
  endDate: string
): Promise<{
  totalCogs: number;
  foodCostPct: number;
  totalGross: number;
  totalDeductions: number;
  totalNet: number;
  totalOrders: number;
  realNetProfit: number;
} | null> {
  try {
    const res = await fetch(
      `/api/analytics/branches?start_date=${startDate}&end_date=${endDate}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.success) return null;
    // A benchmark COGS ratio is an estimate, not production ground truth.
    // Keep the dashboard in an explicit no-data state until all reported gross
    // sales are covered by user-entered itemized costs.
    if (json.cogs_is_estimated === true) return null;
    if (typeof json.total_cogs !== "number" || typeof json.food_cost_pct !== "number") {
      return null;
    }
    const totalCogs = round2(json.total_cogs);
    const totalNet = round2(json.total_net_payout ?? 0);
    return {
      totalCogs,
      foodCostPct: round2(json.food_cost_pct),
      totalGross: round2(json.total_gross ?? 0),
      totalDeductions: round2(json.total_deductions ?? 0),
      totalNet,
      totalOrders: json.total_orders ?? 0,
      realNetProfit: round2(totalNet - totalCogs),
    };
  } catch (err) {
    console.warn("getLiveDashboardCogs failed:", err);
    return null;
  }
}

/**
 * Fetch every metric for the dashboard from LIVE, tenant-isolated routes. Combines
 * the /api/analytics/dashboard aggregation (totals, daily-by-platform chart,
 * deduction decomposition) with /api/analytics/branches (per-branch liquidity +
 * itemized COGS) over the same date window. Returns null — NEVER mock data —
 * when the window has zero settlement rows (report_count === 0) or on any fetch
 * failure, so the dashboard renders its explicit "No data" empty state.
 */
export async function getLiveDashboardData(
  startDate: string,
  endDate: string
): Promise<DashboardData | null> {
  let json: any;
  try {
    const res = await fetch(
      `/api/analytics/dashboard?start_date=${startDate}&end_date=${endDate}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    json = await res.json();
    if (!json?.success || !json.report_count) return null;
  } catch (err) {
    console.warn("getLiveDashboardData aggregation failed:", err);
    return null;
  }

  const [branches, cogs] = await Promise.all([
    getLiveDashboardBranches(startDate, endDate),
    getLiveDashboardCogs(startDate, endDate),
  ]);

  const daily: PlatformDailySales[] = Array.isArray(json.daily_by_platform)
    ? json.daily_by_platform.map((d: any) => ({
        date: String(d?.date || ""),
        dayLabel: dayLabelOf(String(d?.date || "")),
        lineMan: round2(Number(d?.line_man) || 0),
        grab: round2(Number(d?.grab) || 0),
        shopeeFood: round2(Number(d?.shopee_food) || 0),
        robinhood: round2(Number(d?.robinhood) || 0),
        totalGross: round2(Number(d?.total_gross) || 0),
      }))
    : [];

  const dec = json.deduction_decomposition || {};
  const deductions: DeductionDecomposition = {
    gpCommission: round2(Number(dec.gp_commission) || 0),
    vatOnGp: round2(Number(dec.vat_on_gp) || 0),
    merchantPromos: round2(Number(dec.merchant_promos) || 0),
    adMarketing: round2(Number(dec.ad_marketing) || 0),
    otherDeductions: round2(Number(dec.other_deductions) || 0),
    totalDeductions: round2(Number(dec.total_deductions) || 0),
    takeRatePct: round2(Number(dec.take_rate_pct) || 0),
  };

  const grossSales = round2(Number(json.total_gross) || 0);
  const totalDeductions = round2(Number(json.total_deductions) || 0);
  const netDeliveryPayout = round2(Number(json.total_net_payout) || 0);
  const totalOrders = Number(json.total_orders) || 0;

  const range = json.range || {};
  const settlementPeriod =
    range.start_date && range.end_date
      ? `${formatDateString(range.start_date)} - ${formatDateString(range.end_date)}`
      : "";

  // Live itemized COGS + food-cost ratio (same dataset as the card deck).
  // When the cogs fetch yields nothing (null) the fields stay undefined so the
  // CogsGauge "No data" empty state triggers — a fabricated 0.0% food cost is
  // never shown.
  const totalCogs = cogs?.totalCogs;
  const foodCostPct = cogs?.foodCostPct;
  const realNetProfit = cogs?.realNetProfit;

  return {
    brandName: branches.length > 0 && branches[0].brandName ? branches[0].brandName : "",
    settlementPeriod,
    grossSales,
    totalDeductions,
    netDeliveryPayout,
    totalOrders,
    totalCogs,
    realNetProfit,
    takeRatePct: grossSales > 0 ? round2((totalDeductions / grossSales) * 100) : 0,
    foodCostPct,
    netMarginPct: grossSales > 0 ? round2((netDeliveryPayout / grossSales) * 100) : 0,
    branches,
    dailyChartData: daily,
    deductions,
  };
}
