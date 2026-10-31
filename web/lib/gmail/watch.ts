import { createClient } from "@/lib/supabase/server";

/**
 * Best-effort (re)establishment of a brand's Google Gmail push watch
 * (Gmail API `users.watch` via the FastAPI ingestion `/gmail/watch` endpoint).
 *
 * Gmail push watches expire after ~7 days; re-establishing the watch whenever
 * a tenant re-connects OAuth or runs a manual sync keeps real-time Pub/Sub
 * ingestion alive without a standalone scheduler.
 *
 * SERVER-TO-SERVER + NON-BLOCKING:
 *  - Reads the live Supabase session access token and forwards it as a JWT
 *    Bearer to FastAPI (it authenticates via JWKS). The refresh token is never
 *    touched here — FastAPI decrypts it server-side.
 *  - NEVER throws: every failure path logs a warning and returns, so callers
 *    (OAuth callback, manual sync) can fire-and-forget without failing their
 *    own success path.
 */
export async function reestablishGmailWatch(brandId: string): Promise<void> {
  try {
    const supabase = await createClient();
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (sessionError || !accessToken) {
      console.warn(
        `[WATCH] No Supabase session access token available; skipping watch ` +
          `re-establishment for brand ${brandId}.`
      );
      return;
    }

    const baseUrl = process.env.INGESTION_API_BASE_URL?.trim() || "http://localhost:8080";
    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/ingestion/gmail/watch`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ brand_id: brandId }),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      console.warn(
        `[WATCH] FastAPI watch ${res.status} for brand ${brandId}: ${errorText.slice(0, 400)}`
      );
      return;
    }

    console.log(`[WATCH] Gmail push watch established for brand ${brandId} (status ${res.status}).`);
  } catch (err: any) {
    console.warn(
      `[WATCH] Gmail watch re-establishment failed for brand ${brandId}:`,
      err?.message || err
    );
  }
}