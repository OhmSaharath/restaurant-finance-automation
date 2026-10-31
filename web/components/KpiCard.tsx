"use client";

import React from "react";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import { formatTHB } from "@/lib/utils";

interface KpiCardProps {
  titleEn: string;
  titleTh: string;
  amount: number | string;
  /** "currency" → ฿ (money); "count" → plain integer (e.g. order count). */
  format?: "currency" | "count";
  deltaPercent: number;
  deltaIsPositiveGood?: boolean;
  subtitle?: string;
  sparklineColor?: string;
  iconBg?: string;
  icon?: React.ReactNode;
}

export function KpiCard({
  titleEn,
  titleTh,
  amount,
  format = "currency",
  deltaPercent,
  deltaIsPositiveGood = true,
  subtitle,
  sparklineColor = "#10b981",
  iconBg = "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
  icon,
}: KpiCardProps) {
  const isPositive = deltaPercent >= 0;
  const isGood = deltaIsPositiveGood ? isPositive : !isPositive;

  const displayValue =
    format === "count"
      ? new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 }).format(
          Number(amount) || 0
        )
      : formatTHB(amount);

  return (
    <div className="dark-glass dark-glass-hover rounded-3xl p-5 border border-white/10 neo-inset relative overflow-hidden flex flex-col justify-between">
      {/* Background ambient glow */}
      <div
        className="absolute -right-6 -bottom-6 w-24 h-24 rounded-full blur-3xl opacity-20 pointer-events-none"
        style={{ backgroundColor: sparklineColor }}
      />

      {/* Card Header */}
      <div className="flex items-center justify-between mb-3 relative z-10">
        <div>
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
            {titleEn}
          </span>
          <span className="text-xs font-semibold text-slate-300">
            {titleTh}
          </span>
        </div>
        {icon && (
          <div className={`w-9 h-9 rounded-2xl flex items-center justify-center ${iconBg} shadow-sm`}>
            {icon}
          </div>
        )}
      </div>

      {/* Main Metric Value */}
      <div className="my-2 relative z-10">
        <div className="text-2xl font-black text-white tracking-tight break-words">
          {displayValue}
        </div>
      </div>

      {/* Delta & Trend Footer */}
      <div className="flex items-center justify-between pt-2 border-t border-white/10 relative z-10">
        <div className="flex items-center gap-1">
          <div
            className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] font-bold ${
              isGood
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                : "bg-red-500/10 text-red-400 border border-red-500/30"
            }`}
          >
            {isPositive ? (
              <ArrowUpRight className="w-3 h-3" />
            ) : (
              <ArrowDownRight className="w-3 h-3" />
            )}
            <span>{Math.abs(deltaPercent).toFixed(1)}%</span>
          </div>
          <span className="text-[11px] text-slate-400">vs last cycle</span>
        </div>

        {subtitle && (
          <span className="text-[11px] font-medium text-slate-400 truncate max-w-[120px]">
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );
}
