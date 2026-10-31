import { NextRequest, NextResponse } from "next/server";
import { getTenantUserContext, hasWorkspaceWriteAccess, resolveBrandId } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * DELETE /api/integrations/loyverse/disconnect
 * Remove the Loyverse config row for the resolved brand (admin client — full
 * CRUD to service_role per the RLS policy). Returns { success }. The deleted
 * row's encrypted token is never read or returned.
 *
 * Rate limit: 10/min/IP (fixed-window, in-memory).
 */
export async function DELETE(req: NextRequest) {
  const rl = checkRateLimit(req, { max: 10, windowMs: 60_000 });
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
    if (!hasWorkspaceWriteAccess(ctx)) {
      return NextResponse.json({ error: "PARTNER_READ_ONLY" }, { status: 403 });
    }
    const brandId = resolveBrandId(ctx, null);
    if (!brandId) {
      return NextResponse.json({ error: "NO_TENANT_BRAND" }, { status: 403 });
    }

    const admin = createAdminClient();
    const { error } = await admin
      .from("loyverse_config")
      .delete()
      .eq("brand_id", brandId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
