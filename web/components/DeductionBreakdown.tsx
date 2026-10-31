"use client";

import React from "react";
import { Inbox } from "lucide-react";
import { formatTHB, formatPercent } from "@/lib/utils";
import { DeductionDecomposition } from "@/lib/data";

interface DeductionBreakdownProps {
  data?: DeductionDecomposition;
  grossSales?: number;
}

export function DeductionBreakdown({
  data,
  grossSales,
}: DeductionBreakdownProps) {
  // No fabricated breakdown: without data (or no recorded deductions) we render
  // an explicit empty state instead of the decomposition.
  if (!data || data.totalDeductions <= 0) {
    return (
      <div className="bg-[#131522] border border-white/5 rounded-3xl p-6 h-full flex flex-col justify-between">
        <div className="flex flex-col items-center justify-center my-12 text-center">
          <Inbox className="w-10 h-10 text-zinc-600 mb-3" />
          <p className="text-sm font-semibold text-zinc-300">No data for this period.</p>
          <p className="text-xs text-zinc-500 mt-1">
            No deductions were recorded within the selected window.
          </p>
        </div>
      </div>
    );
  }
  const gross = Number(grossSales) || 0;
  const items = [
    {
      category: "Commission GP (30%)",
      categoryTh: "ค่าคอมมิชชั่นแพลตฟอร์ม",
      amount: data.gpCommission,
      percentage: gross > 0 ? (data.gpCommission / gross) * 100 : 0,
      color: "bg-indigo-500",
    },
    {
      category: "VAT on GP (7%)",
      categoryTh: "ภาษีมูลค่าเพิ่มค่า GP",
      amount: data.vatOnGp,
      percentage: gross > 0 ? (data.vatOnGp / gross) * 100 : 0,
      color: "bg-purple-500",
    },
    {
      category: "Merchant Promo / Campaign",
      categoryTh: "ส่วนลดและโปรโมชั่นร่วม",
      amount: data.merchantPromos,
      percentage: gross > 0 ? (data.merchantPromos / gross) * 100 : 0,
      color: "bg-amber-500",
    },
    {
      category: "Listing Ads / Sponsored",
      categoryTh: "ค่าโฆษณาและการมองเห็น",
      amount: data.adMarketing,
      percentage: gross > 0 ? (data.adMarketing / gross) * 100 : 0,
      color: "bg-rose-500",
    },
    {
      category: "Other Fees / Charges",
      categoryTh: "\u0e04\u0e32\u0e48\u0e43\u0e0a\u0e49\u0e08\u0e48\u0e32\u0e22\u0e2d\u0e37\u0e48\u0e19\u0e46",
      amount: data.otherDeductions,
      percentage: gross > 0 ? (data.otherDeductions / gross) * 100 : 0,
      color: "bg-zinc-500",
    },
  ];

  return (
    <div className="bg-[#131522] border border-white/5 rounded-3xl p-6 h-full flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-bold text-slate-200">
              Platform Fee & Deduction Decomposition
            </h3>
            <p className="text-xs text-slate-400">
              Detailed breakdown of commissions, tax, and ad expenditures
            </p>
          </div>
          <span className="text-xs font-bold text-slate-200">
            Total: {formatTHB(data.totalDeductions)}
          </span>
        </div>

        {/* Multi-segment Progress Bar */}
        <div className="h-3.5 w-full rounded-full bg-white/10 flex overflow-hidden p-0.5 gap-0.5 mb-6">
          {items.map((d, i) => (
            <div
              key={i}
              className={`h-full rounded-full ${d.color}`}
              style={{
                width: `${data.totalDeductions > 0 ? (d.amount / data.totalDeductions) * 100 : 25}%`,
              }}
            />
          ))}
        </div>

        {/* Breakdown List */}
        <div className="space-y-3.5">
          {items.map((d, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2.5">
                <span className={`w-2.5 h-2.5 rounded-full ${d.color}`} />
                <div>
                  <div className="font-semibold text-slate-200">{d.category}</div>
                  <div className="text-[10px] text-slate-400">{d.categoryTh}</div>
                </div>
              </div>

              <div className="text-right">
                <div className="font-bold text-slate-200">{formatTHB(d.amount)}</div>
                <div className="text-[10px] font-medium text-slate-400">
                  {formatPercent(d.percentage)} of gross
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between text-[11px] text-slate-400">
        <span>Effective Take Rate:</span>
        <span className="font-bold text-slate-200">
          {formatPercent(data.takeRatePct)} of Gross Sales
        </span>
      </div>
    </div>
  );
}
