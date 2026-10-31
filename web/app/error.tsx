"use client";

import React, { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, Compass, Home } from "lucide-react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log unexpected runtime errors gracefully
    console.error("Root Error Boundary caught runtime exception:", error);
  }, [error]);

  return (
    <div className="min-h-screen w-full bg-[#121417] text-white flex items-center justify-center p-6">
      <div className="relative w-full max-w-lg bg-[#1a1d24]/90 backdrop-blur-2xl border border-white/10 rounded-3xl p-8 shadow-2xl">
        {/* Error Glow Aura */}
        <div className="absolute -inset-4 bg-gradient-to-tr from-amber-500/10 via-red-500/10 to-transparent rounded-[36px] blur-2xl -z-10 pointer-events-none" />

        {/* Header Badge */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shadow-lg">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white tracking-tight">
              Resto Terminal Resilience Recovery
            </h2>
            <p className="text-xs text-slate-400">
              Runtime exception intercepted gracefully
            </p>
          </div>
        </div>

        {/* Error Detail Box */}
        <div className="mb-6 p-4 rounded-2xl bg-black/40 border border-white/5 font-mono text-xs text-slate-300 space-y-1">
          <p className="text-amber-400 font-semibold">
            {error.message || "An unexpected rendering error occurred"}
          </p>
          {error.digest && (
            <p className="text-[11px] text-slate-500">Digest: {error.digest}</p>
          )}
        </div>

        {/* Action Buttons */}
        <div className="space-y-3">
          <button
            onClick={() => reset()}
            className="w-full py-3.5 px-4 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-slate-950 font-bold text-sm rounded-2xl transition-all shadow-lg shadow-emerald-500/25 flex items-center justify-center gap-2 cursor-pointer active:scale-95"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Reset & Re-sync Dashboard</span>
          </button>

          <div className="grid grid-cols-2 gap-3 pt-2">
            <Link
              href="/"
              className="py-3 px-4 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 hover:text-white font-medium text-xs text-center flex items-center justify-center gap-2 transition-all"
            >
              <Home className="w-3.5 h-3.5 text-slate-400" />
              <span>Main Overview</span>
            </Link>

            <Link
              href="/welcome"
              className="py-3 px-4 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-emerald-400 hover:text-emerald-300 font-medium text-xs text-center flex items-center justify-center gap-2 transition-all"
            >
              <Compass className="w-3.5 h-3.5" />
              <span>Landing Poster</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
