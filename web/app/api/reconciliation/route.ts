import { NextResponse, NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";

const PAGE_SIZE = 500;

export async function GET(req: NextRequest) {
  const rl = checkRateLimit(req, { max: 60, windowMs: 60_000, keyPrefix: "reconciliation" });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please retry later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((rl.retryAfterMs ?? 60_000) / 1000)),
        },
      }
    );
  }

  try {
    const ctx = await getTenantUserContext();
    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = await createClient();
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

    // Paginate across PostgREST pages so stores with >1,000 daily_reports rows are not truncated.
    const data: any[] = [];
    let offset = 0;
    while (true) {
      let query = supabase
        .from("daily_reports")
        .select(
          "id, report_date, platform, shop_name_raw, order_count, gross_sales, deductions, net_sale, details, branches!inner(id, branch_code, branch_name, brand_id, brands(id, name))"
        )
        .eq("branches.is_active", true);

      if (isSingleBrand) {
        query = query.eq("branches.brand_id", requestedBrand);
      } else {
        query = query.in("branches.brand_id", brandIds);
      }

      const { data: page, error } = await query
        .order("report_date", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      const rows = page || [];
      data.push(...rows);
      if (rows.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return NextResponse.json({ success: true, data }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || String(err) }, { status: 500 });
  }
}
