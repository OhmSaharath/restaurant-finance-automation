import { NextRequest, NextResponse } from "next/server";
import { getTenantUserContext, resolveBrandId } from "@/lib/auth";
import { encryptSecret, verifyState } from "@/lib/gmail/crypto";
import { exchangeCode, getGmailProfile } from "@/lib/gmail/google";
import { reestablishGmailWatch } from "@/lib/gmail/watch";
import { createAdminClient } from "@/lib/supabase/admin";

const SETTINGS_PATH = "/settings/integrations";

/**
 * Build an ABSOLUTE redirect target (required by NextResponse.redirect, which
 * throws `TypeError: Invalid URL` on a bare relative path). The origin comes
 * from the live request, so the Location header survives proxies / custom ports
 * (e.g. http://localhost:3001).
 */
function settingsUrl(origin: string, status: "connected" | "error", message?: string): string {
  const url = new URL(SETTINGS_PATH, origin);
  url.searchParams.set("status", status);
  if (message) url.searchParams.set("message", message);
  return url.toString();
}

/**
 * Build the exact OAuth callback URL for the current origin. This MUST equal
 * both (a) the `redirect_uri` Google issued the code against and (b) the
 * `redirect_uri` sent on the token-exchange request — otherwise Google rejects
 * the code with `invalid_grant`.
 */
function callbackUrl(origin: string): string {
  return new URL("/api/auth/callback/google", origin).toString();
}

/**
 * GET /api/auth/callback/google
 * OAuth redirect target. Verifies the signed `state` (CSRF + replay protection),
 * exchanges the authorization `code` for tokens, encrypts the refresh token,
 * and upserts it into `public.tenant_integrations` via the Service Role client.
 * User is redirected back to `/settings/integrations?status=connected`.
 */
export async function GET(req: NextRequest) {
  // Derive the absolute origin ONCE (survives proxies / non-standard ports) and
  // reuse it for every redirect target so the URL is always absolute.
  const origin = req.nextUrl.origin;
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const oauthError = searchParams.get("error");

  if (oauthError) {
    return NextResponse.redirect(
      settingsUrl(origin, "error", `Google authorization denied: ${oauthError}`)
    );
  }
  if (!code || !state) {
    return NextResponse.redirect(
      settingsUrl(origin, "error", "Missing authorization code or state parameter.")
    );
  }

  // 1. Verify the signed state and extract the bound brand_id (CSRF-safe).
  const brandIdFromState = verifyState(state);
  if (!brandIdFromState) {
    return NextResponse.redirect(
      settingsUrl(origin, "error", "Invalid or expired OAuth state token.")
    );
  }

  // 2. Re-confirm the caller is authenticated AND belongs to the brand bound
  //    in the state token — a captured link cannot be reused cross-tenant.
  const ctx = await getTenantUserContext();
  // No client brand accepted on the OAuth callback — always resolve the
  // authenticated user's primary brand and compare it against the state-bound
  // brand (CSRF-safe: a captured link cannot be reused cross-tenant).
  const brandId = ctx ? resolveBrandId(ctx, null) : null;
  if (!ctx?.userId || !brandId || brandId !== brandIdFromState) {
    return NextResponse.redirect(
      settingsUrl(origin, "error", "Session tenant does not match the OAuth state.")
    );
  }

  try {
    // 3. Exchange code for access + refresh tokens. The redirect_uri sent to
    //    Google MUST be the exact callback URI for THIS origin (the same one
    //    Google redirected the code to). A mismatch yields `invalid_grant`.
    const tokens = await exchangeCode(code, callbackUrl(origin));
    if (!tokens.refresh_token) {
      throw new Error(
        "Google returned no refresh_token. The account's refresh token was probably already used; re-consent is required."
      );
    }

    // 4. Resolve the connected Gmail address (gmail.readonly scope).
    const email = await getGmailProfile(tokens.access_token);

    // 5. Encrypt the refresh token (AES-256-GCM) for at-rest storage.
    const encrypted = encryptSecret(tokens.refresh_token);

    // 6. Upsert via Service Role client (RLS-scoped users cannot INSERT/UPDATE).
    const admin = createAdminClient();
    const { error } = await admin.from("tenant_integrations").upsert(
      {
        brand_id: brandId,
        provider: "google_gmail",
        encrypted_refresh_token: encrypted,
        email_address: email,
        sync_status: "idle",
        last_synced_at: null,
      },
      { onConflict: "brand_id, provider" }
    );

    if (error) {
      console.warn("tenant_integrations upsert error:", error);
      return NextResponse.redirect(
        settingsUrl(origin, "error", `Failed to persist integration: ${error.message}`)
      );
    }

    // 7. Best-effort establish the Gmail push watch. This is NON-BLOCKING:
    //    failures (e.g. GMAIL_PUBSUB_TOPIC not configured) are logged, NEVER
    //    fatal — the user is still redirected to `?status=connected` and can
    //    sync manually. Keeps the 7-day watch alive right from connect.
    await reestablishGmailWatch(brandId);

    return NextResponse.redirect(settingsUrl(origin, "connected"));
  } catch (err: any) {
    // Error path uses the SAME absolute-URL construction so a failure during
    // token exchange / upsert cannot itself crash into a recursive redirect.
    console.warn("Google OAuth callback error:", err);
    return NextResponse.redirect(
      settingsUrl(origin, "error", err?.message || String(err))
    );
  }
}
