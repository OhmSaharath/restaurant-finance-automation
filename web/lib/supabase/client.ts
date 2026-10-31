import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is not configured. Refusing to bootstrap the Supabase browser client."
    );
  }

  // Browser (RLS) client uses ONLY the public anon key. The Service Role key must
  // never reach the browser bundle — throw instead of silently falling back.
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY is not configured. Refusing to bootstrap the Supabase browser client without an anon key."
    );
  }

  return createBrowserClient(url, key);
}