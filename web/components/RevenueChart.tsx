"use client";

import React from "react";
import { Inbox } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { formatTHB } from "@/lib/utils";
import { PlatformDailySales } from "@/lib/data";

export function RevenueChart({ data }: { data?: PlatformDailySales[] }) {
  const hasData = !!data && data.length > 0;

  return (
    <div className="bg-[#131522] border border-white/5 rounded-3xl p-6 h-full flex flex-col justify-between">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-bold text-slate-200">
            Platform Revenue Volume
          </h3>
          <p className="text-xs text-slate-400">
            Daily gross sales comparison across delivery channels (THB)
          </p>
        </div>
        <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-white/5 text-slate-400 border border-white/10">
          Selected Window
        </span>
      </div>

      {hasData ? (
        <div className="w-full h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} barGap={3} barSize={10}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#2b303b" />
              <XAxis
                dataKey="dayLabel"
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(val) => `฿${(val / 1000).toFixed(0)}k`}
              />
              <Tooltip
                formatter={(val: any) => [formatTHB(Number(val)), ""]}
                contentStyle={{
                  backgroundColor: "rgba(255, 255, 255, 0.9)",
                  backdropFilter: "blur(12px)",
                  borderRadius: "16px",
                  border: "1px solid rgba(255, 255, 255, 0.8)",
                  boxShadow: "0 10px 25px rgba(0,0,0,0.05)",
                  fontSize: "12px",
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }}
                iconType="circle"
              />
              <Bar dataKey="lineMan" name="LINE MAN" fill="#06c755" radius={[4, 4, 0, 0]} />
              <Bar dataKey="grab" name="Grab" fill="#00b14f" radius={[4, 4, 0, 0]} />
              <Bar dataKey="shopeeFood" name="Shopee Food" fill="#ee4d2d" radius={[4, 4, 0, 0]} />
              <Bar dataKey="robinhood" name="Robinhood" fill="#6b3387" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center my-12 text-center">
          <Inbox className="w-10 h-10 text-zinc-600 mb-3" />
          <p className="text-sm font-semibold text-zinc-300">No data for this period.</p>
          <p className="text-xs text-zinc-500 mt-1">
            No platform settlements were recorded within the selected window.
          </p>
        </div>
      )}
    </div>
  );
}