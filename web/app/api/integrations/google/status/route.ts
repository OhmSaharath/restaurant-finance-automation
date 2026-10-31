import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext, resolveBrandId } from "@/lib/auth";

/**
 * GET /api/integrations/google/status
 * Returns the Gmail connection status for the authenticated tenant brand
 * (email_address, sync_status, last_synced_at). Read via the RLS-scoped session
 * client so a user only ever sees their own brand's integration.
 */
export async function GET() {
  try {
    const ctx = await getTenantUserContext();
    if (!ctx || !ctx.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const brandId = resolveBrandId(ctx, null);
    if (!brandId) {
      return NextResponse.json({ connected: false }, { status: 200 });
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("tenant_integrations")
      .select("id, provider, email_address, sync_status, last_synced_at")
      .eq("provider", "google_gmail")
      .eq("brand_id", brandId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ connected: false }, { status: 200 });
    }

    return NextResponse.json(
      {
        connected: true,
        email: data.email_address,
        sync_status: data.sync_status,
        last_synced_at: data.last_synced_at,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
