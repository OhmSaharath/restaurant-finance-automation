/**
 * Server-side Google OAuth 2.0 + Gmail API helpers (plain fetch-based; no heavy
 * googleapis SDK dependency). Used only from API routes / server code.
 *
 * SCOPE SECURITY: Strict least privilege — only `gmail.readonly` is requested.
 * `access_type=offline` + `prompt=consent` force Google to return a persistent
 * refresh_token on first consent.
 */

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// ---------------------------------------------------------------------------
// Settlement-email search query (Grab / LINE MAN) — SEPARATED per platform so
// one platform's higher email volume never exhausts the pagination limit and
// starves the other. Each is a bare sender+attachment filter; date-range
// refinement is appended at the call site in the sync route.
// ---------------------------------------------------------------------------
export const LINEMAN_QUERY = "from:no-reply-merchant@lmwn.com has:attachment";
export const GRAB_QUERY = "from:no-reply@grab.com has:attachment";

/**
 * Application-level exclusion keywords (invoices, receipts, newsletters).
 * Thai "tax invoice" is provided as clean escapes (Thai block).
 */
export const SETTLEMENT_EXCLUDE_MARKERS = [
  "Invoice",
  "Tax Invoice",
  "Receipt",
  "\u0E43\u0E1A\u0E01\u0E33\u0E01\u0E31\u0E1A\u0E20\u0E32\u0E29\u0E35", // Thai: tax invoice
];

function googleClientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!id) throw new Error("GOOGLE_CLIENT_ID not configured.");
  return id;
}

function googleClientSecret(): string {
  const secret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET not configured.");
  return secret;
}

function googleRedirectUri(): string {
  const uri = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (!uri) throw new Error("GOOGLE_REDIRECT_URI not configured.");
  return uri;
}

/**
 * Build the authorization URL for the console consent page.
 *
 * TREATED AS SECURITY-CRITICAL — never weaken these:
 *  - scope:        `gmail.readonly` (strict least privilege, read-only)
 *  - access_type:  `offline` (persistent refresh_token for server-side sync)
 *  - prompt:       `select_account consent` — shows the "Choose an account" UI
 *                  EVERY attempt (so the user can pick which Google profile to
 *                  link) AND forces the consent screen. Without `select_account`
 *                  Google silently reuses the default signed-in profile.
 */
export function buildGoogleAuthUrl({ state }: { state: string }): string {
  const params = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GMAIL_READONLY_SCOPE,
    access_type: "offline",
    prompt: "select_account consent",
    state,
    include_granted_scopes: "true",
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TokenBundle {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function postToken(payload: Record<string, string>): Promise<TokenBundle> {
  const body = new URLSearchParams(payload);
  body.set("client_id", googleClientId());
  body.set("client_secret", googleClientSecret());
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    throw new Error(`Google token exchange failed: ${json?.error || res.status}`);
  }
  if (!json.access_token) {
    throw new Error(`Google token exchange returned no access_token: ${res.status}`);
  }
  return {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : undefined,
    expires_in: Number(json.expires_in || 3600),
  };
}

/**
 * Exchange the OAuth `code` for access + refresh tokens.
 *
 * `redirectUri` MUST be the exact callback URL whose origin initiated the
 * request — the same one Google issued the code against and the same one sent
 * on the original authorization request. A trailing-slash or host mismatch
 * causes Google to reject the exchange with `invalid_grant`.
 */
export function exchangeCode(code: string, redirectUri: string): Promise<TokenBundle> {
  return postToken({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
}

/** Refresh an expired access token using the stored refresh token. */
export function refreshAccessToken(refreshToken: string): Promise<TokenBundle> {
  return postToken({ refresh_token: refreshToken, grant_type: "refresh_token" });
}

/** Fetch the connected Gmail address (works with gmail.readonly scope). */
export async function getGmailProfile(accessToken: string): Promise<string> {
  const res = await fetch(`${GMAIL_API_BASE}/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.emailAddress) {
    throw new Error(`Failed to fetch Gmail profile: ${res.status}`);
  }
  return String(json.emailAddress);
}

/** Search Gmail with a Gmail-QL query. Returns message ids (newest first). */
export async function gmailSearch(
  accessToken: string,
  query: string,
  maxResults = 10
): Promise<Array<{ id: string; threadId: string }>> {
  const results: Array<{ id: string; threadId: string }> = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q: query });
    if (pageToken) params.set("pageToken", pageToken);
    console.log("[GMAIL DEBUG] 🔍 Searching with query:", query);
    const res = await fetch(`${GMAIL_API_BASE}/messages?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[GMAIL ERROR] ❌ Search failed | Status: ${res.status} | Body:`, json);
      throw new Error(`Gmail search failed (${res.status}): ${JSON.stringify(json)}`);
    }
    for (const m of json?.messages || []) {
      if (results.length >= maxResults) break;
      results.push({ id: String(m.id), threadId: String(m.threadId) });
    }
    pageToken = json?.nextPageToken;
  } while (pageToken && results.length < maxResults);
  console.log("[GMAIL DEBUG] 📬 Messages found:", results.length);
  return results;
}

export interface GmailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size?: number;
}

export interface GmailMessage {
  id: string;
  headers: { subject: string; from: string; date: string };
  attachments: GmailAttachment[];
}

/** Fetch a full message and list its attachments + key headers. */
export async function getGmailMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
  console.log("[SYNC DEBUG] 📨 Fetching message details for ID:", messageId);
  const res = await fetch(`${GMAIL_API_BASE}/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`[SYNC ERROR] ❌ Message fetch failed (${res.status}):`, errorBody);
    throw new Error(`Gmail message fetch failed (${res.status}): ${errorBody}`);
  }
  const m = await res.json().catch(() => ({}));
  if (!m?.id) {
    throw new Error(`Gmail message fetch returned no id for ID ${messageId}`);
  }
  const headers: Record<string, string> = {};
  (m?.payload?.headers || []).forEach((h: any) => {
    headers[String(h.name).toLowerCase()] = String(h.value || "");
  });
  const parts: any[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (Array.isArray(node.parts)) node.parts.forEach(walk);
    if (node?.body?.attachmentId && node?.filename) {
      parts.push({
        attachmentId: node.body.attachmentId,
        filename: node.filename,
        mimeType: node.mimeType || "application/octet-stream",
        size: node.body.size,
      });
    }
  };
  walk(m?.payload);
  return {
    id: String(m.id),
    headers: {
      subject: headers.subject || "",
      from: headers.from || "",
      date: headers.date || "",
    },
    attachments: parts,
  };
}

/** Download a single attachment as raw bytes + filename. */
export async function downloadGmailAttachment(
  accessToken: string,
  messageId: string,
  attachment: GmailAttachment
): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
  const params = new URLSearchParams({ mimeType: attachment.mimeType });
  const res = await fetch(
    `${GMAIL_API_BASE}/messages/${messageId}/attachments/${attachment.attachmentId}?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`[SYNC ERROR] ❌ Attachment fetch failed (${res.status}):`, errorBody);
    throw new Error(`Gmail attachment fetch failed (${res.status}): ${errorBody}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!json?.data) {
    throw new Error(`Gmail attachment download returned no data for ${attachment.filename}`);
  }
  return {
    buffer: Buffer.from(String(json.data), "base64url"),
    filename: attachment.filename,
    mimeType: attachment.mimeType,
  };
}
