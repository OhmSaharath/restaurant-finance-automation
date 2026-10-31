"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  AlertTriangle,
  Check,
  CreditCard,
  Loader2,
  ShieldCheck,
  Sparkles,
  Store,
} from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { PricingSection } from "@/components/ui/pricing";
import { createClient } from "@/lib/supabase/client";

/* =============================================================================
   Billing & Subscription — Stripe (Checkout + Portal via backend proxy)
   ----------------------------------------------------------------------------
   Reads the current brand's subscription status through our /api/billing/*
   proxy routes (which resolve brand_id server-side from getTenantUserContext
   and forward to FastAPI). Renders:
     * none     -> hero with "99 THB / month / branch", "30-day free trial",
                   and a "Start free trial" button that opens Stripe Checkout.
     * trialing / active / past_due / canceled / incomplete -> status badge,
                   plus (when subscribed) a "Manage subscription" button that
                   opens the Stripe Customer Portal.
   Branch count is display-only (read via the RLS browser client; the backend
   computes quantity on its own).
   ============================================================================= */

type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid"
  | "paused"
  | "none";

const PRICE_PER_BRANCH_THB = 99;
const TRIAL_DAYS = 30;

const STATUS_META: Record<
  Exclude<SubscriptionStatus, "none">,
  { label: string; color: string; dot: string }
> = {
  trialing: {
    label: "Free trial",
    color: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
    dot: "bg-emerald-400",
  },
  active: {
    label: "Active",
    color: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
    dot: "bg-emerald-400",
  },
  past_due: {
    label: "Payment past due",
    color: "text-amber-300 border-amber-500/30 bg-amber-500/10",
    dot: "bg-amber-400",
  },
  canceled: {
    label: "Canceled",
    color: "text-slate-300 border-white/15 bg-white/5",
    dot: "bg-slate-400",
  },
  incomplete: {
    label: "Incomplete",
    color: "text-amber-300 border-amber-500/30 bg-amber-500/10",
    dot: "bg-amber-400",
  },
  incomplete_expired: {
    label: "Setup expired",
    color: "text-slate-300 border-white/15 bg-white/5",
    dot: "bg-slate-400",
  },
  unpaid: {
    label: "Payment overdue",
    color: "text-amber-300 border-amber-500/30 bg-amber-500/10",
    dot: "bg-amber-400",
  },
  paused: {
    label: "Paused",
    color: "text-slate-300 border-white/15 bg-white/5",
    dot: "bg-slate-400",
  },
};

/** True when the brand currently has a billable/serving subscription. */
function isSubscribed(status: SubscriptionStatus): boolean {
  return (
    status === "active" ||
    status === "trialing" ||
    status === "past_due" ||
    status === "incomplete" ||
    status === "unpaid" ||
    status === "paused"
  );
}

/** Surface a clear, human message from a proxy/FastAPI error response. */
function extractApiError(body: any, status: number, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const detail = body?.detail;
  if (typeof detail === "string" && detail.trim() !== "") return detail;
  if (detail && typeof detail === "object") {
    const msg = detail.message ?? detail.msg ?? detail.error;
    if (typeof msg === "string" && msg.trim() !== "") return msg;
  }
  if (typeof body?.message === "string" && body.message.trim() !== "") {
    return body.message;
  }
  if (typeof body?.error === "string" && body.error.trim() !== "") {
    return body.error;
  }
  if (Array.isArray(detail) && detail.length > 0) {
    const msg = detail[0]?.msg;
    if (typeof msg === "string") return msg;
  }
  return status === 422 ? "Could not complete this request." : fallback;
}

export default function BillingPage() {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [branchCount, setBranchCount] = useState<number | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Display-only branch count (RLS-scoped to the user's brand).
      try {
        const supabase = createClient();
        const { count, error: branchError } = await supabase
          .from("branches")
          .select("id", { count: "exact", head: true })
          .eq("is_active", true);
        if (!branchError) setBranchCount(count ?? null);
      } catch {
        // Branch count is decorative; never block billing on it.
      }

      const res = await fetch("/api/billing/subscription");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          extractApiError(body, res.status, "Could not load your subscription.")
        );
      }
      const KNOWN_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
        "trialing", "active", "past_due", "canceled", "incomplete",
        "incomplete_expired", "unpaid", "paused", "none",
      ]);
      const raw = body?.status;
      const rawStatus: SubscriptionStatus =
        typeof raw === "string" && KNOWN_STATUSES.has(raw as SubscriptionStatus)
          ? (raw as SubscriptionStatus)
          : "none";
      setStatus(rawStatus);
    } catch (err: any) {
      setError(err?.message || "Could not load your subscription.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** POST /api/billing/checkout then redirect to the Stripe Checkout URL. */
  const startTrial = async () => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          extractApiError(body, res.status, "Could not start the free trial.")
        );
      }
      const url: unknown = body?.url;
      if (typeof url !== "string" || url.trim() === "") {
        throw new Error("Stripe did not return a Checkout URL.");
      }
      window.location.href = url;
    } catch (err: any) {
      setError(err?.message || "Could not start the free trial.");
      setActionLoading(false);
    }
    // Keep actionLoading true on success — we're navigating away.
  };

  /** POST /api/billing/portal then redirect to the Stripe Customer Portal URL. */
  const openPortal = async () => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          extractApiError(body, res.status, "Could not open the billing portal.")
        );
      }
      const url: unknown = body?.url;
      if (typeof url !== "string" || url.trim() === "") {
        throw new Error("Stripe did not return a portal URL.");
      }
      window.location.href = url;
    } catch (err: any) {
      setError(err?.message || "Could not open the billing portal.");
      setActionLoading(false);
    }
    // Keep actionLoading true on success — we're navigating away.
  };

  // ---- Loading state ----
  if (loading || status === null) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-emerald-400 animate-spin mx-auto mb-3" />
          <p className="text-xs font-semibold text-slate-400">
            Loading your subscription...
          </p>
        </div>
      </div>
    );
  }

  const isNone = status === "none";
  const subscribed = isSubscribed(status);

  const statusMeta = isNone
    ? null
    : (STATUS_META[status as Exclude<SubscriptionStatus, "none">] as
        | { label: string; color: string; dot: string }
        | undefined);

  // Compact secondary notice for brands that already have a subscription.
  const statusMessage =
    status === "past_due"
      ? "Your latest payment did not go through. Update your payment method to keep your subscription active."
      : status === "incomplete"
        ? "Your subscription is still being set up. Complete the checkout to finish activating it."
        : status === "canceled"
          ? "Your subscription has been canceled. You can view billing details or start a new one in the Stripe portal."
          : "Manage your plan, payment method, and invoices through the Stripe Customer Portal.";

  return (
    <div className="min-h-screen flex bg-[#050505] text-slate-100 subtle-mesh-bg">
      <Sidebar />
      <main className="flex-1 w-full md:ml-64 px-4 md:px-8 py-6">
        <Header />

        <div className="mb-6 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link
                href="/dashboard"
                className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Dashboard</span>
              </Link>
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <CreditCard className="w-6 h-6 text-emerald-400" />
              <span>Billing &amp; Subscription</span>
            </h1>
            <p className="text-xs text-slate-400 max-w-2xl">
              Simple per-branch pricing. Pay as you grow —{" "}
              <span className="text-emerald-400">
                {PRICE_PER_BRANCH_THB} THB / month / branch
              </span>
              , billed securely through Stripe.
            </p>
          </div>
          {!isNone && (
            <span
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                STATUS_META[status as Exclude<SubscriptionStatus, "none">].color
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  STATUS_META[status as Exclude<SubscriptionStatus, "none">].dot
                }`}
              />
              {STATUS_META[status as Exclude<SubscriptionStatus, "none">].label}
            </span>
          )}
        </div>

        {error && (
          <div
            className="mb-4 dark-glass rounded-2xl p-3 border border-red-500/30 text-red-300 text-xs flex items-center gap-2"
            role="alert"
          >
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* ---- Plan & pricing (always visible: primary element) ---- */}
        <PricingSection
          plans={[
            {
              name: "Standard",
              price: PRICE_PER_BRANCH_THB,
              period: "/ month / branch",
              description:
                branchCount !== null && branchCount > 0
                  ? `Based on your ${branchCount} active branche${
                      branchCount === 1 ? "" : "s"
                    }, that's ${(
                      PRICE_PER_BRANCH_THB * branchCount
                    ).toLocaleString("en-US")} THB / month.`
                  : "Priced by your active branch count — adjusts automatically as you grow.",
              features: [
                `${TRIAL_DAYS}-day free trial (full access)`,
                "Per-branch pricing — pay as you grow",
                "Secure billing via Stripe",
                "Daily P&L + real COGS analytics",
                "Gmail sales-data sync",
                "Cancel anytime",
              ],
              buttonText: subscribed ? "Manage subscription" : "Start free trial",
              isPopular: true,
            },
          ]}
          title="Simple, transparent pricing"
          description="One plan. Pay per branch. Cancel anytime."
          onSelectPlan={() => (subscribed ? openPortal() : startTrial())}
          actionLoading={actionLoading}
        />

        {/* ---- Secondary status notice for existing subscriptions ---- */}
        {!isNone && statusMeta && (
          <div className="max-w-2xl mx-auto mb-10 -mt-4 dark-glass rounded-2xl border border-white/10 p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
              <Store className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white truncate">
                {statusMeta.label} subscription
              </p>
              <p className="text-xs text-slate-400">{statusMessage}</p>
              {branchCount !== null && branchCount > 0 && (
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {branchCount} active branche{branchCount === 1 ? "" : "s"} ·{" "}
                  {PRICE_PER_BRANCH_THB} THB / month / branch ·{" "}
                  {(PRICE_PER_BRANCH_THB * branchCount).toLocaleString("en-US")}{" "}
                  THB / month
                </p>
              )}
            </div>
            <p className="shrink-0 hidden md:flex items-center gap-1.5 text-[10px] text-slate-500">
              <ShieldCheck className="w-3.5 h-3.5" />
              Secured by Stripe
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
