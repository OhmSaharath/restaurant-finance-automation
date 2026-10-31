import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTenantUserContext, hasWorkspaceWriteAccess, resolveBrandId } from "@/lib/auth";
import { decryptSecret } from "@/lib/gmail/crypto";
import { downloadGmailAttachment, gmailSearch, getGmailMessage, GRAB_QUERY, LINEMAN_QUERY, refreshAccessToken, SETTLEMENT_EXCLUDE_MARKERS, type GmailMessage } from "@/lib/gmail/google";
import { reestablishGmailWatch } from "@/lib/gmail/watch";

/**
 * POST /api/integrations/google/sync
 * Ingestion worker: pulls Grab / LINE MAN settlement emails from the connected
 * Gmail account, downloads statement attachments, and forwards them to the
 * FastAPI ingestion pipeline for parsing + idempotent reconciliation.
 *
 * SECURITY & PRECISION:
 *  - Strict rate limit: max 5 sync requests per hour per brand_id.
 *  - The refresh token is decrypted in-memory only, never logged or returned.
 *  - Financial guardrail (net = gross - deductions, NUMERIC(12,2)) is enforced
 *    in the FastAPI ingestion layer, which persists normalized data into
 *    daily_reports.details (JSONB).
 */

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

const MAX_MESSAGES_PER_SYNC = 200;
const MESSAGE_THROTTLE_MS = 500;
const STALE_SYNC_LOCK_MS = 15 * 60 * 1000; // 15 minutes

interface SyncRangePayload {
  rangeType: "days" | "custom";
  days?: number;
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
}

function getDateFilterSuffix(payload: SyncRangePayload): { suffix: string; spanDays: number } {
  let spanDays = 30;
  if (payload.rangeType === "days") {
    const days = Math.max(1, Math.min(3650, Math.floor(Number(payload.days) || 7)));
    return { suffix: `newer_than:${days}d`, spanDays: days };
  } else if (payload.rangeType === "custom" && payload.startDate && payload.endDate) {
    const after = payload.startDate.replace(/-/g, "/");
    const before = payload.endDate.replace(/-/g, "/");
    const startMs = Date.parse(payload.startDate);
    const endMs = Date.parse(payload.endDate);
    spanDays = Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1);
    return { suffix: `after:${after} before:${before}`, spanDays };
  }
  return { suffix: "newer_than:7d", spanDays: 7 };
}

async function forwardToFastAPI(
  attachmentBuffer: Buffer,
  filename: string,
  platform: "lineman" | "grab",
  accessToken: string,
  brandId: string,
  sender?: string,
  subject?: string
): Promise<{ ok: boolean; status: number; error?: string; body?: any }> {
  const baseUrl = process.env.INGESTION_API_BASE_URL?.trim() || "http://localhost:8080";
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/ingestion/${platform}`;

  const arrayBuffer = new Uint8Array(attachmentBuffer).buffer as ArrayBuffer;
  const fileBlob = new Blob([arrayBuffer], { type: "application/octet-stream" });

  const formData = new FormData();
  formData.append("file", fileBlob, filename);
  formData.append("brand_id", brandId || "");
  formData.append("sender", sender || "");
  formData.append("subject", subject || "");

  console.log(`[SYNC DEBUG] Forwarding attachment "${filename}" to FastAPI (${platform})...`);
  console.log(`[SYNC DEBUG] 🚀 Posting to: ${endpoint}`);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    });
    console.log(`[SYNC DEBUG] FastAPI Response Status: ${res.status}`);

    // Read body stream once as text, then parse JSON safely.
    const rawText = await res.text().catch(() => "");
    let body: any = {};
    if (rawText) {
      try {
        body = JSON.parse(rawText);
      } catch {
        body = { message: rawText };
      }
    }
    if (!res.ok) {
      const errorText = rawText || JSON.stringify(body);
      console.error(`[SYNC ERROR] ❌ FastAPI ${res.status} at ${endpoint}:`, errorText);
      return { ok: false, status: res.status, error: errorText, body };
    }
    return { ok: true, status: res.status, body };
  } catch (err: any) {
    console.error(`[SYNC ERROR] ❌ Network call failed:`, err?.message || err);
    return { ok: false, status: 500, error: err?.message || String(err) };
  }
}

async function markSyncState(brandId: string, status: "idle" | "syncing" | "error", lastSyncedAt?: boolean): Promise<void> {
  const admin = createAdminClient();
  const payload: Record<string, unknown> = { sync_status: status };
  if (lastSyncedAt) payload.last_synced_at = new Date().toISOString();
  await admin
    .from("tenant_integrations")
    .update(payload)
    .eq("brand_id", brandId)
    .eq("provider", "google_gmail");
}

const GMAIL_QUOTA_PATTERN = /403|rateLimitExceeded|quota exceeded/i;
const GMAIL_BACKOFF_MS = 3000;
async function withGmailBackoff<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (!GMAIL_QUOTA_PATTERN.test(msg)) throw err;
    console.warn(`[SYNC] ⏳ Gmail quota/rate error ("${msg}") — waiting ${GMAIL_BACKOFF_MS}ms and retrying once.`);
    await new Promise((r) => setTimeout(r, GMAIL_BACKOFF_MS));
    return await fn();
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await getTenantUserContext();
  if (!ctx || !ctx.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasWorkspaceWriteAccess(ctx)) {
    return NextResponse.json({ error: "PARTNER_READ_ONLY" }, { status: 403 });
  }

  let payload: SyncRangePayload;
  let requestedBrand: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body === "object" && typeof (body as any).brand_id === "string") {
      requestedBrand = (body as any).brand_id as string;
    }
    payload = {
      rangeType: (body?.rangeType === "custom" ? "custom" : "days") as "days" | "custom",
      days: body?.days,
      startDate: body?.startDate,
      endDate: body?.endDate,
    };
  } catch {
    payload = { rangeType: "days", days: 7 };
  }
  const brandId = resolveBrandId(ctx, requestedBrand);
  if (!brandId) {
    return NextResponse.json({ error: "NO_TENANT_BRAND" }, { status: 403 });
  }
  console.log("[SYNC DEBUG] Brand ID:", brandId);
  let dateSuffix: string;
  let spanDays: number;
  try {
    const suffixed = getDateFilterSuffix(payload);
    dateSuffix = suffixed.suffix;
    spanDays = suffixed.spanDays;
  } catch (err: any) {
    return NextResponse.json(
      { error: "INVALID_RANGE", message: err?.message || "Invalid sync range payload." },
      { status: 400 }
    );
  }

  const now = Date.now();
  let bucket = rateBuckets.get(brandId);
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    rateBuckets.set(brandId, bucket);
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((bucket.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Max 5 sync requests per hour per brand." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }
  bucket.count += 1;

  const supabase = await createClient();

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const sessionAccessToken = sessionData?.session?.access_token;
  if (sessionError || !sessionAccessToken) {
    return NextResponse.json(
      { error: "NO_SESSION_TOKEN", message: "No live Supabase session access token available." },
      { status: 401 }
    );
  }

  const { data: integration, error: fetchError } = await supabase
    .from("tenant_integrations")
    .select("encrypted_refresh_token, email_address")
    .eq("provider", "google_gmail")
    .eq("brand_id", brandId)
    .maybeSingle();

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  if (!integration?.encrypted_refresh_token) {
    return NextResponse.json(
      { error: "NOT_CONNECTED", message: "No Gmail integration found for this brand." },
      { status: 400 }
    );
  }

  let refreshToken: string;
  try {
    console.log("[SYNC DEBUG] Decrypting refresh token...");
    refreshToken = decryptSecret(integration.encrypted_refresh_token);
  } catch (err: any) {
    await markSyncState(brandId, "error");
    return NextResponse.json({ error: "DECRYPT_FAILED", message: err?.message || String(err) }, { status: 500 });
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const { data: syncClaim, error: syncClaimError } = await admin
    .from("tenant_integrations")
    .update({ sync_status: "syncing", last_synced_at: nowIso })
    .eq("brand_id", brandId)
    .eq("provider", "google_gmail")
    .neq("sync_status", "syncing")
    .select("id");
  if (syncClaimError) {
    return NextResponse.json({ error: "SYNC_CLAIM_FAILED", message: syncClaimError.message }, { status: 503 });
  }

  let claimed = Boolean(syncClaim && syncClaim.length > 0);
  if (!claimed) {
    // Recover stale 'syncing' lock if older than 15 minutes
    const staleCutoffMs = Date.now() - STALE_SYNC_LOCK_MS;
    const { data: existingLock } = await admin
      .from("tenant_integrations")
      .select("id, sync_status, last_synced_at")
      .eq("brand_id", brandId)
      .eq("provider", "google_gmail")
      .maybeSingle();
    const lockTs = existingLock?.last_synced_at ? Date.parse(String(existingLock.last_synced_at)) : NaN;
    const isStale = existingLock?.sync_status === "syncing" && (!Number.isFinite(lockTs) || lockTs <= staleCutoffMs);
    if (isStale) {
      const { data: reclaimed } = await admin
        .from("tenant_integrations")
        .update({ sync_status: "syncing", last_synced_at: nowIso })
        .eq("brand_id", brandId)
        .eq("provider", "google_gmail")
        .eq("sync_status", "syncing")
        .select("id");
      claimed = Boolean(reclaimed && reclaimed.length > 0);
    }
  }

  if (!claimed) {
    return NextResponse.json(
      { error: "SYNC_IN_PROGRESS", message: "A Gmail sync is already running for this workspace." },
      { status: 409 }
    );
  }

  try {
    const tokens = await refreshAccessToken(refreshToken);
    console.log("[SYNC DEBUG] Acquired access token successfully.");

    const maxResultsPerPlatform = Math.max(20, Math.min(MAX_MESSAGES_PER_SYNC, spanDays * 3));

    const linemanFullQuery = `${LINEMAN_QUERY} ${dateSuffix}`;
    const grabFullQuery = `${GRAB_QUERY} ${dateSuffix}`;

    const summary = {
      messages_scanned: 0,
      attachments_downloaded: 0,
      ingested_total: 0,
      ingested_upserted: 0,
      grab_records: 0,
      lineman_records: 0,
      skipped: 0,
      errors: [] as string[],
    };

    async function processMessages(messages: any[], expectedPlatform: "lineman" | "grab") {
      console.log(`[SYNC DEBUG] Iterating ${messages.length} ${expectedPlatform} messages...`);
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (i > 0) await new Promise((r) => setTimeout(r, MESSAGE_THROTTLE_MS));

        let message: GmailMessage;
        try {
          message = await withGmailBackoff(() => getGmailMessage(tokens.access_token, msg.id));
        } catch (err: any) {
          summary.errors.push(`[gmail] msg ${msg.id}: ${err?.message || err}`);
          continue;
        }

        const subject = message.headers.subject || "";

        const isExcluded = SETTLEMENT_EXCLUDE_MARKERS.some((marker) =>
          subject.toLowerCase().includes(marker.toLowerCase())
        );
        if (isExcluded) {
          summary.skipped += 1;
          continue;
        }

        for (const attachment of message.attachments) {
          try {
            const file = await withGmailBackoff(() =>
              downloadGmailAttachment(tokens.access_token, msg.id, attachment)
            );
            summary.attachments_downloaded += 1;
            const result = await forwardToFastAPI(
              file.buffer,
              file.filename,
              expectedPlatform,
              sessionAccessToken || "",
              brandId || "",
              message.headers.from || "",
              subject
            );
            if (result.ok) {
              const processed = Number(result.body?.total_processed || 0);
              const upserted = Number(result.body?.total_upserted || 0);
              summary.ingested_total += processed;
              summary.ingested_upserted += upserted;
              if (expectedPlatform === "grab") summary.grab_records += processed;
              else summary.lineman_records += processed;
            } else {
              summary.errors.push(`[${expectedPlatform}] ${file.filename}: ${result.error}`);
            }
          } catch (err: any) {
            summary.errors.push(`[${expectedPlatform}] ${attachment.filename}: ${err?.message}`);
          }
        }
      }
    }

    const lmFound = await gmailSearch(tokens.access_token, linemanFullQuery, maxResultsPerPlatform);
    summary.messages_scanned += lmFound.length;
    await processMessages(lmFound, "lineman");

    const grabFound = await gmailSearch(tokens.access_token, grabFullQuery, maxResultsPerPlatform);
    summary.messages_scanned += grabFound.length;
    await processMessages(grabFound, "grab");

    await markSyncState(brandId, "idle", true);
    await reestablishGmailWatch(brandId);

    return NextResponse.json(
      { success: true, range: { rangeType: payload.rangeType, spanDays }, summary, brand_id: brandId },
      { status: 200 }
    );
  } catch (err: any) {
    await markSyncState(brandId, "error");
    return NextResponse.json({ error: "SYNC_FAILED", message: err?.message || String(err) }, { status: 500 });
  }
}
