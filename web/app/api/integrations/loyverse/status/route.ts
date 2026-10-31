import { NextRequest, NextResponse } from "next/server";
import { getTenantUserContext, resolveBrandId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * GET /api/integrations/loyverse/status
 * Return ONLY metadata for the resolved brand's Loyverse config:
 * { configured, enabled, vat_enabled, vat_rate, store_branch_map, item_selection }.
 * The encrypted access token is NEVER selected, decrypted, or returned — the
 * token stays server-side only. Read via the RLS-scoped session client so a
 * user only sees their own brand's row.
 *
 * Rate limit: 30/min/IP (fixed-window, in-memory).
 */
export async function GET(req: NextRequest) {
  const rl = checkRateLimit(req, { max: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfterMs ?? 60_000) / 1000)) } }
    );
  }

  try {
    const ctx = await getTenantUserContext();
    if (!ctx || !ctx.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const brandId = resolveBrandId(ctx, null);
    if (!brandId) {
      return NextResponse.json({ error: "NO_TENANT_BRAND" }, { status: 403 });
    }

    const supabase = await createClient();
    // Explicit column list — encrypted_access_token is intentionally absent.
    const { data, error } = await supabase
      .from("loyverse_config")
      .select("enabled, vat_enabled, vat_rate, store_branch_map, item_selection")
      .eq("brand_id", brandId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json(
        {
          configured: false,
          enabled: false,
          vat_enabled: false,
          vat_rate: null,
          store_branch_map: [],
          item_selection: [],
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        configured: true,
        enabled: data.enabled === true,
        vat_enabled: data.vat_enabled === true,
        vat_rate: data.vat_rate,
        store_branch_map: Array.isArray(data.store_branch_map) ? data.store_branch_map : [],
        item_selection: Array.isArray(data.item_selection) ? data.item_selection : [],
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}