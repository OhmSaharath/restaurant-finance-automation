import { NextResponse } from "next/server";
import { getTenantUserContext, hasWorkspaceWriteAccess, resolveBrandId } from "@/lib/auth";
import { signState } from "@/lib/gmail/crypto";
import { buildGoogleAuthUrl } from "@/lib/gmail/google";

/**
 * GET /api/integrations/google/connect
 * Entry point for the "Connect Gmail Account" button. Validates the tenant
 * session, then redirects the browser to Google's OAuth consent page with a
 * signed `state` token bound to the caller's authenticated brand_id (CSRF-safe).
 */
export async function GET() {
  try {
    const ctx = await getTenantUserContext();
    if (!ctx || !ctx.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!hasWorkspaceWriteAccess(ctx)) {
      return NextResponse.json({ error: "PARTNER_READ_ONLY" }, { status: 403 });
    }
    // Integration credentials are stored per-brand. A user must belong to a
    // brand to initiate a connection (HQ-wide connections are not supported).
    const brandId = resolveBrandId(ctx, null);
    if (!brandId) {
      return NextResponse.json(
        {
          error: "NO_TENANT_BRAND",
          message:
            "No tenant brand is assigned to this account. Connect Google Gmail from a brand-scoped user account.",
        },
        { status: 403 }
      );
    }

    const authUrl = buildGoogleAuthUrl({ state: signState(brandId) });
    return NextResponse.redirect(authUrl);
  } catch (err: any) {
    return NextResponse.json(
      { error: "CONNECT_FAILED", message: err?.message || String(err) },
      { status: 500 }
    );
  }
}
