import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "crypto";

/**
 * Server-side cryptographic helpers for the Google OAuth pipeline.
 *
 * - AES-256-GCM encryption for storing Google refresh tokens at rest
 *   (ENCRYPTION_KEY, server-only).
 * - HMAC-SHA256 signed OAuth `state` token containing the tenant brand_id, to
 *   prevent CSRF / state-tampering on the OAuth redirect.
 *
 * These functions MUST only ever run on the server (API routes / server
 * actions) — never import this module from client components.
 */

const br = (s: string) => new TextEncoder().encode(s);

function requireEncryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY?.trim();
  if (!key) {
    throw new Error("ENCRYPTION_KEY not configured. Refusing to operate on secrets.");
  }
  if (key.length < 32) {
    throw new Error("ENCRYPTION_KEY is too short. Use at least 32 characters.");
  }
  return key;
}

/** Deterministic 256-bit key derivation for AES (from ENCRYPTION_KEY). */
function aesKey(): Uint8Array {
  return createHash("sha256").update(br(requireEncryptionKey())).digest();
}

/** Deterministic HMAC signing key for OAuth `state` (domain-separated). */
function stateHmacKey(): string {
  return requireEncryptionKey() + ":google-oauth-state";
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** AES-256-GCM encrypt. Output format: `<ivB64>.<tagB64>.<ciphertextB64>`. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(), iv);
  const ct = Buffer.concat([cipher.update(br(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${toBase64(iv)}.${toBase64(tag)}.${toBase64(ct)}`;
}

/** AES-256-GCM decrypt. Throws AuthTagError on tampering / wrong key. */
export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, ctB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("Invalid encrypted payload format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", aesKey(), fromBase64(ivB64));
  decipher.setAuthTag(fromBase64(tagB64));
  const pt = Buffer.concat([decipher.update(fromBase64(ctB64)), decipher.final()]);
  return pt.toString("utf-8");
}

/**
 * Sign an OAuth `state` value binding a brand_id to the authorization request.
 * Prevents CSRF: an attacker cannot forge a state for a brand they do not own,
 * and a captured state cannot be replayed later.
 */
export function signState(brandId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ brand_id: brandId, exp: Date.now() + 10 * 60 * 1000, nonce: randomBytes(8).toString() })
  ).toString("base64url");
  const sig = createHmac("sha256", stateHmacKey()).update(payload).digest();
  return `${payload}.${toBase64(sig)}`;
}

/** Verify a signed state token. Returns the brand_id when valid, else null. */
export function verifyState(state: string): string | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = state.slice(0, dot);
  const sigB64 = state.slice(dot + 1);

  const expected = createHmac("sha256", stateHmacKey()).update(payload).digest();
  const supplied = fromBase64(sigB64);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return null; // tampered or forged state
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    const brandId = typeof decoded?.brand_id === "string" ? decoded.brand_id : null;
    const exp = typeof decoded?.exp === "number" ? decoded.exp : 0;
    if (!brandId || Date.now() > exp) return null; // expired / malformed
    return brandId;
  } catch {
    return null;
  }
}