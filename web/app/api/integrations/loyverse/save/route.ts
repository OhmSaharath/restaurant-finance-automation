import { NextRequest, NextResponse } from "next/server";
import { getTenantUserContext, hasWorkspaceWriteAccess, resolveBrandId } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptSecret } from "@/lib/gmail/crypto";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/integrations/loyverse/save
 * Persist the owner's Loyverse Personal Access Token for the resolved brand.
 * The token is encrypted at rest (AES-256-GCM via encryptSecret) and stored in
 * loyverse_config.encrypted_access_token through the Service Role client (RLS
 * users have no INSERT/UPDATE on this table — token writes are server-only).
 * The plaintext token is never logged and never returned.
 *
 * Rate limit: 10/min/IP (fixed-window, in-memory).
 */
export async function POST(req: NextRequest) {
  const rl = checkRateLimit(req, { max: 10, windowMs: 60_000, keyPrefix: "loyverse-save" });
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

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "INVALID_JSON", message: "Invalid JSON body." }, { status: 400 });
    }

    const requestedBrand =
      typeof body?.brand_id === "string" && body.brand_id.trim()
        ? body.brand_id.trim()
        : new URL(req.url).searchParams.get("brand_id");
    const brandId = resolveBrandId(ctx, requestedBrand);
    if (!brandId) {
      return NextResponse.json({ error: "NO_TENANT_BRAND" }, { status: 403 });
    }

    const rawToken = typeof body?.access_token === "string" ? body.access_token.trim() : "";
    if (!rawToken) {
      return NextResponse.json(
        { error: "INVALID_TOKEN", message: "A non-empty Loyverse access token is required." },
        { status: 400 }
      );
    }

    // Encrypt at rest. Never log the plaintext.
    const encrypted = encryptSecret(rawToken);

    const admin = createAdminClient();
    const { error } = await admin.from("loyverse_config").upsert(
      {
        brand_id: brandId,
        encrypted_access_token: encrypted,
        enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "brand_id" }
    );

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, brand_id: brandId }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
