import { NextRequest, NextResponse } from "next/server";
import { getTenantUserContext, resolveBrandId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/gmail/crypto";
import { listItems } from "@/lib/loyverse/client";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * GET /api/integrations/loyverse/items
 * List the brand's Loyverse catalog items (id + name + variant cost) so the
 * owner can pick which menu items flow into revenue/COGS.
 *
 * The access token is NEVER client-supplied here: it is read from the stored
 * loyverse_config row for the resolved brand (session client), decrypted
 * server-side, used only for the API call, and never logged or returned.
 *
 * Rate limit: 10/min/IP (fixed-window, in-memory).
 */
export async function GET(req: NextRequest) {
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
    const brandId = resolveBrandId(ctx, null);
    if (!brandId) {
      return NextResponse.json({ error: "NO_TENANT_BRAND" }, { status: 403 });
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("loyverse_config")
      .select("encrypted_access_token")
      .eq("brand_id", brandId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data?.encrypted_access_token) {
      return NextResponse.json(
        { ok: false, configured: false, error: "No Loyverse token is saved for this brand. Paste a token first." },
        { status: 200 }
      );
    }

    let token: string;
    try {
      token = decryptSecret(data.encrypted_access_token);
    } catch {
      // Generic 500 — never echo decrypt internals or any token material.
      return NextResponse.json(
        { ok: false, error: "Stored Loyverse token could not be decrypted. Re-save the token." },
        { status: 500 }
      );
    }

    const items = await listItems(token);
    return NextResponse.json({ ok: true, items }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 }
    );
  }
}