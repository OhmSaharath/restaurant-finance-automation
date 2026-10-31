"use client";

import React, { useEffect, useState } from "react";
import {
  Search,
  Calendar,
  UploadCloud,
  FileDown,
  Bell,
} from "lucide-react";
import {
  fetchCurrentUser,
  onUserUpdated,
  type CurrentUser,
} from "@/lib/current-user";
import { deriveDisplayName, deriveInitials } from "@/lib/user-display";

interface HeaderProps {
  ownerName?: string;
  brandName?: string;
  settlementPeriod?: string;
  onUploadClick?: () => void;
}

export function Header({
  ownerName,
  brandName,
  settlementPeriod = "Live period",
  onUploadClick,
}: HeaderProps) {
  const [user, setUser] = useState<CurrentUser | null>(null);

  useEffect(() => {
    let active = true;
    fetchCurrentUser().then((u) => {
      if (active) setUser(u);
    });
    const off = onUserUpdated(async () => {
      const u = await fetchCurrentUser();
      if (active) setUser(u);
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  // Live display name wins; the prop is only a fallback for slow loads.
  const liveOwnerName = user ? deriveDisplayName(user.fullName, user.email) : null;
  const effectiveOwnerName = liveOwnerName || ownerName || "there";
  const effectiveBrandName =
    (brandName && brandName.trim()) || user?.brandName || "Workspace";
  const brandLogoUrl = user?.brandLogoUrl || null;
  const headerInitials = user ? deriveInitials(user.fullName, user.email) : "··";
  return (
    <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 py-4 px-4 md:px-8 mb-6 border border-white/10 dark-glass rounded-3xl">
      {/* Left: Greeting & Date */}
      <div className="w-full min-w-0 md:w-auto">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold text-white tracking-tight break-words">
            Sawadee, {effectiveOwnerName} 👋
          </h1>
          <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20 inline-flex items-center gap-1.5">
            {brandLogoUrl ? (
              <img src={brandLogoUrl} alt="" className="w-4 h-4 rounded object-contain" />
            ) : null}
            {effectiveBrandName}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-1">
          <Calendar className="w-3.5 h-3.5 text-slate-500" />
          <span>Settlement Period: {settlementPeriod}</span>
        </div>
      </div>

      {/* Middle: Search Bar */}
      <div className="flex-1 max-w-md hidden md:block">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
          <input
            type="text"
            placeholder="Search branches, order IDs, or settlement payout refs..."
            className="w-full pl-10 pr-4 py-2 bg-white/5 border border-white/10 rounded-2xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition-all shadow-sm"
          />
        </div>
      </div>

      {/* Right: Quick Actions & Profile */}
      <div className="flex flex-col items-stretch sm:flex-row md:items-center gap-3 w-full md:w-auto">
        <button
          onClick={onUploadClick}
          className="py-2.5 px-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-2xl text-xs font-semibold shadow-lg shadow-emerald-600/20 flex items-center justify-center gap-2 transition-all active:scale-95 w-full sm:w-auto"
        >
          <UploadCloud className="w-4 h-4" />
          <span>Upload Settlement</span>
        </button>

        <button className="py-2.5 px-3 bg-white/5 hover:bg-white/10 text-slate-200 rounded-2xl text-xs font-semibold border border-white/10 shadow-sm flex items-center gap-1.5 transition-all">
          <FileDown className="w-4 h-4 text-slate-400" />
          <span className="hidden sm:inline">Export P&L</span>
        </button>

        <button className="p-2.5 bg-white/5 hover:bg-white/10 text-slate-300 rounded-2xl border border-white/10 shadow-sm relative transition-all">
          <Bell className="w-4 h-4" />
          <span className="w-2 h-2 rounded-full bg-emerald-400 absolute top-2 right-2 ring-2 ring-black animate-pulse" />
        </button>

        <div className="flex items-center gap-2.5 pl-2 border-l border-white/10">
          {user?.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={effectiveOwnerName}
              className="w-9 h-9 rounded-2xl object-cover border border-white/10 shadow-md"
            />
          ) : (
            <div className="w-9 h-9 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-600 text-white flex items-center justify-center font-bold text-xs shadow-md">
              {headerInitials}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
