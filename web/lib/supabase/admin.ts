import { createClient as createAdminClientFactory, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase Service Role client.
 *
 * SECURITY: Uses the `SUPABASE_SERVICE_ROLE_KEY` env var, which has NO
 * `NEXT_PUBLIC_` prefix. Next.js only inlines `NEXT_PUBLIC_*` variables into
 * client-side bundles, so this key (and the admin client) can NEVER reach the
 * browser. Importing this module from any client component is a build break.
 *
 * This client bypasses RLS and is used exclusively for writing OAuth tokens
 * during the Google callback and for marking sync state during the worker.
 * All reads that should honor tenant isolation must use the session-scoped
 * client from "@/lib/supabase/server" instead.
 */
let _admin: SupabaseClient | null = null;

export function createAdminClient(): SupabaseClient {
  if (_admin) return _admin;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url) {
    throw new Error("Supabase URL not configured. Refusing to bootstrap the Service Role client.");
  }
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY not configured. Refusing to bootstrap the Service Role client."
    );
  }

  _admin = createAdminClientFactory(url, key, { auth: { persistSession: false } });
  return _admin;
}