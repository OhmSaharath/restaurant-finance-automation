"use client";

import React, { useState, useRef } from "react";
import { motion, useMotionValue, useSpring, useTransform, AnimatePresence } from "framer-motion";
import { MapPin, Navigation, Maximize2, Minimize2, Store, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LocationMapProps {
  location?: string;
  coordinates?: string;
  branchCode?: string;
  platforms?: string[];
  className?: string;
}

export function LocationMap({
  location = "",
  coordinates = "",
  branchCode = "",
  platforms = [],
  className,
}: LocationMapProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // 3D Perspective Tilt physics
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const mouseXSpring = useSpring(x, { stiffness: 300, damping: 30 });
  const mouseYSpring = useSpring(y, { stiffness: 300, damping: 30 });

  const rotateX = useTransform(mouseYSpring, [-0.5, 0.5], ["12deg", "-12deg"]);
  const rotateY = useTransform(mouseXSpring, [-0.5, 0.5], ["-12deg", "12deg"]);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current || isExpanded) return;
    const rect = cardRef.current.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const xPct = mouseX / width - 0.5;
    const yPct = mouseY / height - 0.5;

    x.set(xPct);
    y.set(yPct);
  };

  const handleMouseLeave = () => {
    x.set(0);
    y.set(0);
  };

  return (
    <motion.div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        rotateX: isExpanded ? "0deg" : rotateX,
        rotateY: isExpanded ? "0deg" : rotateY,
        transformStyle: "preserve-3d",
      }}
      className={cn(
        "relative rounded-3xl overflow-hidden glass-card border border-white/80 transition-all duration-300 shadow-glass",
        isExpanded ? "h-[380px]" : "h-[220px]",
        className
      )}
    >
      {/* Background SVG Vector Map Grid */}
      <div className="absolute inset-0 bg-slate-900 overflow-hidden pointer-events-none">
        {/* Soft Radial ambient light */}
        <div className="absolute inset-0 bg-gradient-to-tr from-emerald-950/80 via-slate-900 to-slate-950" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-emerald-500/15 rounded-full blur-3xl" />

        {/* Stylized Vector Street Lines */}
        <svg
          className="w-full h-full opacity-35"
          viewBox="0 0 400 300"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M-20 60 L420 80" stroke="#10b981" strokeWidth="2" strokeDasharray="6 4" />
          <path d="M-20 180 L420 160" stroke="#10b981" strokeWidth="3" />
          <path d="M120 -20 L140 320" stroke="#10b981" strokeWidth="2.5" />
          <path d="M280 -20 L260 320" stroke="#10b981" strokeWidth="1.5" strokeDasharray="8 6" />
          <path d="M40 220 L380 40" stroke="#059669" strokeWidth="4" />
          <path d="M-10 120 C 150 140, 220 60, 410 100" stroke="#34d399" strokeWidth="2" />

          {/* Street blocks */}
          <rect x="50" y="95" width="60" height="50" rx="6" fill="#064e3b" fillOpacity="0.4" />
          <rect x="150" y="90" width="95" height="60" rx="8" fill="#064e3b" fillOpacity="0.5" />
          <rect x="150" y="175" width="95" height="70" rx="8" fill="#064e3b" fillOpacity="0.3" />
          <rect x="290" y="70" width="70" height="75" rx="8" fill="#064e3b" fillOpacity="0.4" />
        </svg>

        {/* Live branch beacon (coordinates are shown only when supplied by the database). */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center">
          <span className="animate-ping absolute inline-flex h-12 w-12 rounded-full bg-emerald-400 opacity-40" />
          <span className="relative inline-flex rounded-full h-5 w-5 bg-emerald-500 border-2 border-white shadow-lg items-center justify-center text-white">
            <Store className="w-2.5 h-2.5" />
          </span>
        </div>
      </div>

      {/* Foreground Content Overlay */}
      <div className="relative z-10 p-5 h-full flex flex-col justify-between text-white">
        {/* Top bar: Branch code badge & expand toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 rounded-xl bg-emerald-500/30 text-emerald-300 text-[11px] font-mono font-bold border border-emerald-400/40 backdrop-blur-md">
              {branchCode}
            </span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/10 text-slate-200 border border-white/20">
              Branch
            </span>
          </div>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white backdrop-blur-md transition-all"
            aria-label={isExpanded ? "Minimize map" : "Expand map"}
          >
            {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* Bottom card info */}
        <div className="p-3.5 rounded-2xl bg-slate-900/80 backdrop-blur-md border border-white/15">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-bold text-white mb-0.5">
                <MapPin className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="line-clamp-1">{location}</span>
              </div>
              <div className="flex items-center gap-1 text-[10px] font-mono text-emerald-300/80">
                <Navigation className="w-3 h-3 text-emerald-400" />
                <span>{coordinates}</span>
              </div>
            </div>

            <div className="text-right shrink-0">
              <span className="text-[10px] text-slate-400 uppercase tracking-widest block font-medium">
                Platforms
              </span>
              <div className="flex gap-1 mt-0.5">
                {platforms.map((p) => (
                  <span
                    key={p}
                    className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-700/50"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
