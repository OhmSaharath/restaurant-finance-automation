import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  let cookieStore: any = null;
  try {
    cookieStore = await cookies();
  } catch (err) {
    console.warn("Could not read cookies from server context:", err);
  }

  // No placeholder / fallback keys: bootstrapping the server client must fail loudly
  // when real credentials are missing. The server client is RLS-scoped (session cookies)
  // and MUST never fall back to a Service Role key.

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "Supabase URL not configured. Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL). Refusing to bootstrap the server client."
    );
  }

  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY not configured. Refusing to bootstrap the server client without an anon key."
    );
  }

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        try {
          return cookieStore ? cookieStore.getAll() : [];
        } catch {
          return [];
        }
      },
      setAll(
        cookiesToSet: Array<{
          name: string;
          value: string;
          options: CookieOptions;
        }>
      ) {
        try {
          if (cookieStore) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          }
        } catch {
          // Ignored if called from a Server Component
        }
      },
    },
  });
}