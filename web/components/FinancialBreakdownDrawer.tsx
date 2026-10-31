"use client";

import React from "react";
import { DollarSign, Receipt } from "lucide-react";
import { formatTHB, parseFinancialDetails } from "@/lib/utils";

interface FinancialBreakdownDrawerProps {
  platform: string;
  details: any;
  grossSales: number;
}

/**
 * Two-card drawer rendering parsed JSONB financial breakdown for a single
 * branch/platform/date. Uses th-TH NUMERIC(12,2) currency formatting and never
 * fabricates 0.00 where the raw JSONB holds positive deduction values.
 */
export function FinancialBreakdownDrawer({
  platform,
  details,
  grossSales,
}: FinancialBreakdownDrawerProps) {
  const parsed = parseFinancialDetails(platform, details);
  const { payments, deductions, vatIncludedInGp } = parsed;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
      {/* Revenue / Payment Inflows */}
      <div className="p-4 rounded-2xl bg-white/5 border border-white/10 space-y-3">
        <div className="flex items-center gap-2 text-xs font-bold text-emerald-400 uppercase tracking-wider">
          <DollarSign className="w-4 h-4" />
          <span>Revenue Inflows (Payment Breakdown)</span>
        </div>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between text-slate-300">
            <span>E-Payment Inflow:</span>
            <span className="font-mono font-semibold text-white">
              {formatTHB(payments.ePayment)}
            </span>
          </div>
          <div className="flex justify-between text-slate-300">
            <span>Cash Inflow (COD):</span>
            <span className="font-mono font-semibold text-white">
              {formatTHB(payments.cash)}
            </span>
          </div>
          {payments.campaigns > 0 && (
            <div className="flex justify-between text-slate-300">
              <span>Campaign Subsidies:</span>
              <span className="font-mono font-semibold text-white">
                {formatTHB(payments.campaigns)}
              </span>
            </div>
          )}
          {payments.otherPayments > 0 && (
            <div className="flex justify-between text-slate-300">
              <span>Other Payments:</span>
              <span className="font-mono font-semibold text-white">
                {formatTHB(payments.otherPayments)}
              </span>
            </div>
          )}
          <div className="pt-2 border-t border-white/10 flex justify-between text-white font-bold">
            <span>Total Gross Inflow:</span>
            <span className="font-mono">{formatTHB(grossSales)}</span>
          </div>
        </div>
      </div>

      {/* Deductions Breakdown */}
      <div className="p-4 rounded-2xl bg-white/5 border border-white/10 space-y-3">
        <div className="flex items-center gap-2 text-xs font-bold text-rose-400 uppercase tracking-wider">
          <Receipt className="w-4 h-4" />
          <span>Deductions &amp; Fee Decomposition</span>
        </div>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between text-slate-300">
            <span>GP Commission &amp; Service Fee:</span>
            <span className="font-mono font-semibold text-rose-400">
              -{formatTHB(deductions.gp)}
              {vatIncludedInGp && (
                <span className="text-[9px] text-slate-500 ml-1">(incl. VAT)</span>
              )}
            </span>
          </div>
          <div className="flex justify-between text-slate-300">
            <span>Listing Ads (ค่าโฆษณา):</span>
            <span className="font-mono font-semibold text-rose-400">
              -{formatTHB(deductions.ads)}
            </span>
          </div>
          <div className="flex justify-between text-slate-300">
            <span>Merchant Promotions (โปรโมชันร้าน):</span>
            <span className="font-mono font-semibold text-rose-400">
              -{formatTHB(deductions.promos)}
            </span>
          </div>
          <div className="flex justify-between text-slate-300">
            <span>VAT 7%:</span>
            {vatIncludedInGp ? (
              <span className="font-mono font-semibold text-slate-500">
                included in GP
              </span>
            ) : (
              <span className="font-mono font-semibold text-rose-400">
                -{formatTHB(deductions.vat)}
              </span>
            )}
          </div>
          {deductions.other > 0 && (
            <div className="flex justify-between text-slate-300">
              <span>Other Platform Fees:</span>
              <span className="font-mono font-semibold text-rose-400">
                -{formatTHB(deductions.other)}
              </span>
            </div>
          )}
          <div className="pt-2 border-t border-white/10 flex justify-between text-white font-bold">
            <span>Total Deductions:</span>
            <span className="font-mono text-rose-400">
              -{formatTHB(deductions.total)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}