import { NextRequest, NextResponse } from "next/server";
import { getTenantUserContext, resolveBrandId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/gmail/crypto";
import { testToken } from "@/lib/loyverse/client";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/integrations/loyverse/test
 * Validate a Loyverse token by listing the account's stores.
 *  - body.access_token provided -> test THAT token (never persists it)
 *  - body.access_token omitted  -> test the stored (decrypted) token
 * Returns { ok, stores } or { ok:false, error }. The token itself is never
 * logged and never returned in the response.
 *
 * Rate limit: 10/min/IP (fixed-window, in-memory).
 */
export async function POST(req: NextRequest) {
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

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    let token = typeof body?.access_token === "string" ? body.access_token.trim() : "";

    if (!token) {
      // Fall back to the stored token for the resolved brand.
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
          { ok: false, error: "No Loyverse token is saved for this brand. Paste a token first." },
          { status: 200 }
        );
      }

      try {
        token = decryptSecret(data.encrypted_access_token);
      } catch (err: any) {
        return NextResponse.json(
          { ok: false, error: `Stored token could not be decrypted: ${err?.message || "unknown error"}` },
          { status: 500 }
        );
      }
    }

    const result = await testToken(token);
    return NextResponse.json(result, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 }
    );
  }
}