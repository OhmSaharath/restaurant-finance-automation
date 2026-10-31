"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Store,
  Scale,
  ChefHat,
  FileSpreadsheet,
  Settings,
  Sparkles,
  LogOut,
  Compass,
  Receipt,
  CreditCard,
  TrendingUp,
  Menu,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  fetchCurrentUser,
  onUserUpdated,
  type CurrentUser,
} from "@/lib/current-user";
import {
  roleLabel,
  deriveDisplayName,
  deriveInitials,
} from "@/lib/user-display";

const NAV_ITEMS = [
  { label: "Overview & P&L", href: "/dashboard", icon: LayoutDashboard },
  { label: "Store Branches", href: "/branches", icon: Store },
  { label: "Reconciliation", href: "/reconciliation", icon: Scale },
  { label: "Recipe & BOM", href: "/bom", icon: ChefHat },
  { label: "Menu Sales → COGS", href: "/menu-sales", icon: Receipt },
  { label: "Daily P&L", href: "/daily-pnl", icon: TrendingUp },
  { label: "Billing", href: "/billing", icon: CreditCard },
  { label: "Audit & Settlement", href: "/audit", icon: FileSpreadsheet },
  { label: "Settings & API", href: "/settings", icon: Settings },
];

export function Sidebar({ brandName = "" }: { brandName?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [open, setOpen] = useState(false);

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

  // Close the drawer whenever the route changes (covers nav clicks and
  // browser back/forward on mobile).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Prefer the explicitly-passed brand name, then the live tenant brand,
  // then a neutral fallback (never a hardcoded tenant name).
  const brandLabel =
    (brandName && brandName.trim()) || user?.brandName || "Workspace";
  const brandLogoUrl = user?.brandLogoUrl || null;
  const displayName = user ? deriveDisplayName(user.fullName, user.email) : "…";
  const displayRole = user ? roleLabel(user.role) : "…";
  const initials = user ? deriveInitials(user.fullName, user.email) : "··";

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  };

  return (
    <>
      {/* Mobile hamburger toggle (hidden on md and up) */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={open ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={open}
        className="fixed top-3 left-3 z-40 p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white md:hidden transition-colors"
      >
        {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

      {/* Mobile backdrop overlay (hidden on md and up) */}
      {open && (
        <div
          aria-hidden="true"
          onClick={() => setOpen(false)}
          className="fixed inset-0 bg-black/60 z-20 md:hidden"
        />
      )}

      <aside
        className={`w-64 border-r border-white/10 dark-glass flex flex-col justify-between p-5 min-h-screen max-h-screen overflow-y-auto fixed left-0 top-0 z-30 transition-transform duration-300 ${
          open ? "translate-x-0" : "-translate-x-full"
        } md:translate-x-0`}
      >
        <div>
          {/* Brand Logo & Switcher */}
          <div className="flex items-center gap-3 px-2 py-3 mb-6">
            {brandLogoUrl ? (
              <img
                src={brandLogoUrl}
                alt={`${brandLabel} logo`}
                className="w-10 h-10 rounded-2xl object-contain border border-white/10 shadow-lg shadow-emerald-500/20"
              />
            ) : (
              <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-600 text-white flex items-center justify-center font-bold shadow-lg shadow-emerald-500/20">
                <Sparkles className="w-5 h-5" />
              </div>
            )}
            <div className="overflow-hidden">
              <h2 className="text-sm font-bold text-white truncate leading-tight">
                {brandLabel}
              </h2>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-[11px] font-medium text-slate-400">Live Sync</span>
              </div>
            </div>
          </div>

          {/* Navigation Section */}
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-3 mb-2">
              Main Intelligence
            </p>
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 px-3.5 py-2.5 rounded-2xl text-xs font-semibold transition-all ${
                    isActive
                      ? "bg-white text-slate-900 shadow-md"
                      : "text-slate-400 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <Icon
                    className={`w-4 h-4 ${
                      isActive ? "text-emerald-600" : "text-slate-400"
                    }`}
                  />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>

          {/* Gateway Portal Link */}
          <div className="mt-6 pt-4 border-t border-white/10">
            <Link
              href="/"
              onClick={() => setOpen(false)}
              className="flex items-center justify-between px-3.5 py-2.5 rounded-2xl text-xs font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-all shadow-sm"
            >
              <div className="flex items-center gap-2.5">
                <Compass className="w-4 h-4 text-emerald-400" />
                <span>Landing Poster</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono">
                Gateway
              </span>
            </Link>
          </div>
        </div>

        {/* Footer / User Profile & Sign Out */}
        <div className="pt-4 border-t border-white/10 space-y-3">
          <div className="flex items-center justify-between px-2">
            <div className="flex items-center gap-2.5">
              {user?.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={displayName}
                  className="w-8 h-8 rounded-xl object-cover border border-white/10"
                />
              ) : (
                <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-600 text-white flex items-center justify-center font-bold text-xs">
                  {initials}
                </div>
              )}
              <div className="overflow-hidden">
                <p className="text-xs font-bold text-white truncate">{displayName}</p>
                <p className="text-[10px] text-slate-400 truncate">{displayRole}</p>
              </div>
            </div>
            <button
              onClick={handleSignOut}
              title="Sign Out"
              className="p-2 rounded-xl bg-white/5 hover:bg-red-500/20 hover:text-red-400 text-slate-400 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
