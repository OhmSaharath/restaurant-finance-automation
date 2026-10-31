"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * CallbackHandler — completes the Supabase PKCE / OAuth / OTP code exchange.
 *
 * Must live in its OWN client component that calls useSearchParams(), because
 * Next.js 15 statically prerenders this page and useSearchParams() outside a
 * <Suspense> boundary raises a build-time error. The default export below wraps
 * this handler in <Suspense fallback=...> so the build accepts it.
 *
 * The code exchange runs inside useEffect, guarded by ranRef, so it executes
 * exactly once even though React 19 StrictMode double-invokes effects
 * (mount -> unmount -> remount) in dev. Calling exchangeCodeForSession() twice
 * with the same, already-consumed code errors out and could bounce a successful
 * login to /login?error=auth_failed.
 */
function CallbackHandler() {
  const router = useRouter();
  const params = useSearchParams();
  const code = params.get("code");
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const finish = async () => {
      const supabase = createClient();
      try {
        if (code) {
          // PKCE flow (Google OAuth / email-link with code): swap the code for a
          // session. Magic-link tokens may already be present without a code.
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            router.replace("/login?error=auth_failed");
          } else {
            router.replace("/dashboard");
          }
        } else {
          // Fallback: token may already be embedded in the URL (implicit flow).
          const {
            data: { session },
          } = await supabase.auth.getSession();
          if (session) {
            router.replace("/dashboard");
          } else {
            router.replace("/login?error=auth_failed");
          }
        }
      } catch {
        router.replace("/login?error=auth_failed");
      }
    };

    void finish();
  }, [code, router]);

  return (
    <div className="dark flex min-h-screen items-center justify-center bg-[#131522]">
      <p className="text-sm text-slate-400">Completing your sign in…</p>
    </div>
  );
}

const CallbackFallback = () => (
  <div className="dark flex min-h-screen items-center justify-center bg-[#131522]">
    <p className="text-sm text-slate-400">Finalizing your session…</p>
  </div>
);

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<CallbackFallback />}>
      <CallbackHandler />
    </Suspense>
  );
}
