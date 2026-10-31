"use client";

import React, { useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { ChefHat, ChevronLeft, AtSign } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/* ------------------------------------------------------------------ */
/*  FloatingPaths — animated cubic-bezier SVG wisps (subtle emerald)   */
/*  Rendered twice (position={1} and position={-1}) on the left panel  */
/* ------------------------------------------------------------------ */
function FloatingPaths({ position }: { position: number }) {
  const paths = Array.from({ length: 36 }, (_, i) => ({
    id: i,
    d: `M-${380 - i * 5 * position} -${189 + i * 6}C-${380 - i * 5 * position} -${312 - i * 6} -${308 - i * 5 * position} -${408 - i * 6} -${170 - i * 5 * position} -${343 - i * 6}C${90 - i * 5 * position} -${261 - i * 6} ${48 - i * 5 * position} -${187 - i * 6} ${371 - i * 5 * position} -${491 - i * 6}C${500 - i * 5 * position} -${651 - i * 6} ${635 - i * 5 * position} -${299 - i * 6} ${652 - i * 5 * position} -${59 - i * 6}C${670 - i * 5 * position} ${182 - i * 6} ${591 - i * 5 * position} ${480 - i * 6} ${270 - i * 5 * position} ${390 - i * 6}C${50 - i * 5 * position} ${323 - i * 6} ${220 - i * 5 * position} ${784 - i * 6} ${150 - i * 5 * position} ${282 - i * 6}`,
    color: `rgba(16, 185, 129, ${0.05 + i * 0.02})`,
    width: 0.5 + i * 0.03,
  }));

  return (
    <motion.svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 696 316"
      fill="none"
      aria-hidden="true"
    >
      {paths.map((path) => (
        <motion.path
          key={path.id}
          d={path.d}
          stroke={path.color}
          strokeWidth="1"
          strokeOpacity="0.15"
          initial={{ pathLength: 0.3, opacity: 0.6 }}
          animate={{ pathLength: 1, opacity: 1, pathOffset: [0, 1] }}
          transition={{
            duration: 20 + Math.random() * 10,
            ease: "linear",
            repeat: Infinity,
          }}
        />
      ))}
    </motion.svg>
  );
}

/* -------------------------------------------------------------- */
/*  GoogleIcon — official multi-color Google "G" SVG               */
/* -------------------------------------------------------------- */
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

/* -------------------------------------------------------------- */
/*  AuthSeparator — "OR" between stacked sign-in methods           */
/* -------------------------------------------------------------- */
function AuthSeparator() {
  return (
    <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-widest text-slate-500">
      <div className="h-px flex-1 bg-white/10" />
      <span>OR</span>
      <div className="h-px flex-1 bg-white/10" />
    </div>
  );
}

/* --------------------------------------------------------------- */
/*  Brand mark — ChefHat on a rounded tile (used both panels)       */
/* --------------------------------------------------------------- */
function BrandMark({ className }: { className?: string }) {
  return (
    <div
      className={`flex items-center justify-center rounded-xl border border-white/15 bg-white/5 shadow-lg shadow-emerald-500/10 ${
        className ?? "size-12"
      }`}
    >
      <ChefHat className="size-7 text-emerald-400" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AuthPage — dark split-screen animated auth (adapted "Asme" style) */
/* ------------------------------------------------------------------ */
export default function AuthPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    if (!email.trim()) {
      setMessage({ type: "error", text: "Please enter your email address to continue." });
      return;
    }

    setLoading(true);

    const supabase = createClient();
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (error) {
        setMessage({ type: "error", text: error.message });
      } else {
        setMessage({ type: "success", text: "Check your email for the login link." });
      }
    } catch (err: any) {
      setMessage({
        type: "error",
        text: err?.message || "An unexpected error occurred. Please try again.",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setLoading(true);
    setMessage(null);

    const supabase = createClient();
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      // No success banner — OAuth redirects the browser away on success.
      if (error) {
        setMessage({ type: "error", text: error.message });
      }
    } catch (err: any) {
      setMessage({
        type: "error",
        text: err?.message || "An unexpected error occurred. Please try again.",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dark relative min-h-screen w-full overflow-hidden bg-[#131522]">
      {/* deep slate gradient wash */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.12),transparent_45%),radial-gradient(circle_at_bottom_right,rgba(148,163,184,0.08),transparent_45%)]" />

      <div className="relative mx-auto grid min-h-screen w-full max-w-7xl grid-cols-1 items-center gap-10 px-6 py-8 lg:grid-cols-2 lg:gap-24 lg:py-16 lg:px-12">
        {/* ------------------- LEFT: testimonial panel ------------------- */}
        <motion.div
          initial={{ opacity: 0, x: -24 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.7, ease: "easeOut" }}
          className="relative hidden lg:flex flex-col justify-between gap-12"
        >
          {/* brand + two path layers */}
          <div className="relative">
            <FloatingPaths position={1} />
            <FloatingPaths position={-1} />
            <div className="relative z-10 flex items-center gap-3">
              <BrandMark />
              <span className="text-xl font-bold tracking-tight text-slate-100">
                Restaurant Data Hub
              </span>
            </div>
          </div>

          <figure className="relative z-10">
            <blockquote className="text-2xl font-medium leading-relaxed text-slate-200 lg:text-3xl">
              &ldquo;Connect your delivery platforms and keep every payout,
              deduction, and food cost traceable in one workspace.&rdquo;
            </blockquote>
            <figcaption className="mt-6 flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-full border border-white/15 bg-white/5 text-sm font-bold text-emerald-400">
                RD
              </span>
              <div>
                <div className="text-sm font-semibold text-slate-100">
                  Restaurant Data Hub
                </div>
                <div className="text-xs text-slate-400">
                  Restaurant partner on Restaurant Data Hub
                </div>
              </div>
            </figcaption>
          </figure>
        </motion.div>

        {/* ------------------- RIGHT: auth form panel ------------------- */}
        <motion.div
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.7, ease: "easeOut", delay: 0.1 }}
          className="relative flex flex-col"
        >
          {/* radial glow overlay behind the form card */}
          <div className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-[radial-gradient(circle,rgba(16,185,129,0.16),transparent_60%)] blur-2xl" />

          <div className="relative w-full max-w-md">
            {/* back to home */}
            <Button
              variant="ghost"
              size="sm"
              asChild
              className="mb-8 -ml-2 text-slate-400 hover:text-slate-100"
            >
              <Link href="/">
                <ChevronLeft className="size-4" />
                Back to home
              </Link>
            </Button>

            {/* mobile brand */}
            <div className="mb-6 flex items-center gap-3 lg:hidden">
              <BrandMark className="size-10" />
              <span className="text-lg font-bold tracking-tight text-slate-100">
                Restaurant Data Hub
              </span>
            </div>

            <h1 className="mb-2 text-4xl font-bold tracking-tight text-slate-100">
              Welcome back
            </h1>
            <p className="mb-8 text-sm text-slate-400">
              Sign in to review your Grab and LINE MAN settlement payouts.
            </p>

            {message && (
              <div
                role="status"
                className={`mb-4 rounded-xl border p-3 text-sm ${
                  message.type === "success"
                    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
                    : "border-red-500/25 bg-red-500/10 text-red-400"
                }`}
              >
                {message.text}
              </div>
            )}

            {/* primary auth methods */}
            <div className="space-y-4">
              <Button
                variant="outline"
                size="lg"
                className="w-full border-white/15 bg-white/5 text-slate-100 hover:bg-white/10 hover:text-white"
                onClick={handleGoogleLogin}
                disabled={loading}
              >
                <GoogleIcon className="size-5" />
                Continue with Google
              </Button>

              <AuthSeparator />

              <form onSubmit={handleEmailLogin} className="space-y-4">
                <div className="relative">
                  <AtSign className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
                  <Input
                    type="email"
                    required
                    placeholder="you@restaurant.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="h-11 border-white/15 bg-white/5 pl-10 text-slate-100 placeholder:text-slate-500"
                  />
                </div>
                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  disabled={loading}
                >
                  {loading ? "Signing in..." : "Continue with Email"}
                </Button>
              </form>
            </div>

            {/* footer */}
            <p className="mt-6 text-xs text-slate-500">
              New here?{" "}
              <Link
                href="/register"
                className="font-semibold text-emerald-400 hover:text-emerald-300 transition-colors"
              >
                Create your restaurant account
              </Link>
            </p>

            <p className="mt-4 text-xs text-slate-500">
              By continuing, you agree to our{" "}
              <Link href="/terms" className="text-slate-400 underline-offset-2 hover:underline">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="text-slate-400 underline-offset-2 hover:underline">
                Privacy Policy
              </Link>
              .
            </p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
