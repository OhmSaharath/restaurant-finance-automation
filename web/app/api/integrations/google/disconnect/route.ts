import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext, hasWorkspaceWriteAccess, resolveBrandId } from "@/lib/auth";

/**
 * DELETE /api/integrations/google/disconnect
 * Removes the Gmail integration for the authenticated brand. Delete is permitted
 * for the owning tenant under the RLS `tenant_integrations_delete_tenant` policy.
 */
export async function DELETE() {
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

    const supabase = await createClient();
    const { error } = await supabase
      .from("tenant_integrations")
      .delete()
      .eq("provider", "google_gmail")
      .eq("brand_id", brandId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, connected: false }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
