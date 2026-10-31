import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTenantUserContext } from "@/lib/auth";

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ALLOWED_PLATFORMS = new Set(["Grab", "LINE MAN"]);
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

/**
 * POST /api/integrations/settlement/upload
 * Authenticated tenant proxy for the real FastAPI settlement ingestion routes.
 * No client-supplied brand/user identifier is forwarded; FastAPI derives the
 * tenant scope from the verified Supabase JWT.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = (req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown").trim();
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    bucket.count += 1;
    if (bucket.count > RATE_LIMIT_MAX) {
      return NextResponse.json({ error: "RATE_LIMITED", message: "Too many uploads. Please try again shortly." }, { status: 429, headers: { "Retry-After": String(Math.ceil((bucket.resetAt - now) / 1000)) } });
    }
  }

  const ctx = await getTenantUserContext();
  if (!ctx?.userId || !ctx.brandIds?.length) {
    return NextResponse.json({ error: "NO_TENANT_SCOPE", message: "No brand is linked to this account." }, { status: 401 });
  }

  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return NextResponse.json({ error: "UNAUTHORIZED", message: "Please sign in again." }, { status: 401 });
  }

  try {
    const form = await req.formData();
    const uploaded = form.get("file");
    const platform = form.get("platform");
    if (!(uploaded instanceof File)) {
      return NextResponse.json({ error: "NO_FILE", message: "Choose a settlement file first." }, { status: 400 });
    }
    if (typeof platform !== "string" || !ALLOWED_PLATFORMS.has(platform)) {
      return NextResponse.json({ error: "UNSUPPORTED_PLATFORM", message: "Choose Grab or LINE MAN." }, { status: 400 });
    }
    if (uploaded.size <= 0 || uploaded.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "FILE_TOO_LARGE", message: "Settlement files must be between 1 byte and 15 MB." }, { status: 413 });
    }

    const baseUrl = process.env.INGESTION_API_BASE_URL?.trim() || "http://localhost:8080";
    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/ingestion/${platform === "Grab" ? "grab" : "lineman"}`;
    const upstream = new FormData();
    upstream.append("file", uploaded, uploaded.name || "settlement");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
      body: upstream,
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({ error: "INGESTION_INVALID_RESPONSE", message: "The ingestion service returned an invalid response." }));
    return NextResponse.json(body, { status: response.status });
  } catch (err: any) {
    console.error("[SETTLEMENT UPLOAD ERROR]", err?.message || err);
    return NextResponse.json({ error: "INGESTION_UNAVAILABLE", message: "Settlement ingestion is temporarily unavailable." }, { status: 502 });
  }
}
