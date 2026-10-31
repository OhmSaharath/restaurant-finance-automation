"use client";

import React, { useState } from "react";
import Link from "next/link";
import { PosterStage } from "@/components/landing/PosterStage";
import { AuthModal } from "@/components/landing/AuthModal";
import { Sparkles, ArrowRight, Shield, Layers, Scale } from "lucide-react";

export default function WelcomePage() {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-[#121417] select-none text-white flex flex-col justify-between p-6 sm:p-10">
      {/* 1. Wordmark (Z-Order: z-1) */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[1]">
        <div className="overflow-hidden">
          <h1 className="animate-orb-word font-black text-[min(24vw,44dvh)] tracking-tighter select-none leading-none flex items-center opacity-85">
            <span className="text-white">RE</span>
            <span className="bg-gradient-to-b from-emerald-200 via-emerald-400 to-emerald-600 bg-clip-text text-transparent">
              STO
            </span>
          </h1>
        </div>
      </div>

      {/* 2. Interactive Visual Stack & Canvas Mouse Morph Trail (Z-Order: z-2) */}
      <PosterStage onOpenAuth={() => setModalOpen(true)} />

      {/* 3. Top Header: Brand Mark, Primary Nav Links & Secure Access Pill (Z-Order: z-4) */}
      <header className="animate-orb-nav relative z-[4] w-full max-w-7xl mx-auto flex items-center justify-between pointer-events-auto">
        {/* Top Left: Brand Mark & Nav Links */}
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/25">
              <Sparkles className="w-4 h-4 text-slate-950 font-bold" />
            </div>
            <span className="text-sm font-extrabold tracking-wider text-white uppercase">
              Resto OS
            </span>
          </div>

          {/* Primary Nav Links */}
          <nav className="hidden md:flex items-center gap-7 text-xs font-medium text-slate-400 tracking-wide">
            <Link
              href="#home"
              className="hover:text-emerald-400 transition-colors"
            >
              Home
            </Link>
            <Link
              href="#features"
              className="hover:text-emerald-400 transition-colors flex items-center gap-1.5"
            >
              <Layers className="w-3.5 h-3.5" />
              Multi-Tenant Engine
            </Link>
            <Link
              href="#reconciliation"
              className="hover:text-emerald-400 transition-colors flex items-center gap-1.5"
            >
              <Scale className="w-3.5 h-3.5" />
              Reconciliation BOM
            </Link>
            <Link
              href="#security"
              className="hover:text-emerald-400 transition-colors flex items-center gap-1.5"
            >
              <Shield className="w-3.5 h-3.5" />
              Enterprise Security
            </Link>
          </nav>
        </div>

        {/* Top Right: Secure Access Pill Button */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setModalOpen(true)}
            className="rounded-full bg-white text-black hover:bg-emerald-400 hover:text-slate-950 font-bold text-xs sm:text-sm px-6 py-2.5 transition-all shadow-[0_0_25px_rgba(255,255,255,0.2)] hover:shadow-[0_0_30px_rgba(52,211,153,0.6)] cursor-pointer active:scale-95 flex items-center gap-1.5"
          >
            <span>Enter Terminal</span>
            <span className="text-sm font-normal">➔</span>
          </button>
        </div>
      </header>

      {/* 4. Corner Financial Copy (Z-Order: z-3) */}
      <footer className="relative z-[3] w-full max-w-7xl mx-auto flex flex-col sm:flex-row items-start sm:items-end justify-between gap-4 pointer-events-none text-xs text-slate-400">
        {/* Bottom Left Copy */}
        <div className="animate-orb-corner-left max-w-xs">
          <p className="font-semibold text-slate-300">
            Every delivery platform fee,
          </p>
          <p className="text-slate-500">
            intelligently reconciled.
          </p>
        </div>

        {/* Center Live Indicator (Subtle) */}
        <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-[11px] text-slate-400">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>Multi-Brand Gateway Active</span>
        </div>

        {/* Bottom Right Copy */}
        <div className="animate-orb-corner-right max-w-xs sm:text-right">
          <p className="font-semibold text-slate-300">
            Stop GP & Ad leakages.
          </p>
          <p className="text-emerald-400/90 font-medium">
            Unlock true restaurant net profit.
          </p>
        </div>
      </footer>

      {/* 5. Integrated Supabase Login Modal / Scrim (Z-Order: z-20 / z-30) */}
      <AuthModal isOpen={modalOpen} onClose={() => setModalOpen(false)} />
    </main>
  );
}
