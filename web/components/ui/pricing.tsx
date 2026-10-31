"use client";

import { motion } from "framer-motion";
import { Check, Star } from "lucide-react";
import confetti from "canvas-confetti";
import NumberFlow from "@number-flow/react";
import { cn } from "@/lib/utils";
import { useRef } from "react";

export interface PricingPlan {
  name: string;
  price: number; // THB
  period: string; // e.g. "/ month / branch"
  description: string;
  features: string[];
  buttonText: string;
  isPopular?: boolean;
}

interface PricingSectionProps {
  plans: PricingPlan[];
  title?: string;
  description?: string;
  onSelectPlan?: (plan: PricingPlan) => void;
  actionLoading?: boolean;
}

function fireConfetti(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const origin = {
    x: (rect.left + rect.width / 2) / window.innerWidth,
    y: (rect.top + rect.height / 2) / window.innerHeight,
  };
  // Emerald/teal burst to match the brand accent.
  confetti({
    particleCount: 70,
    spread: 70,
    origin,
    colors: ["#10b981", "#14b8a6", "#34d399", "#0d9488", "#a7f3d0"],
    ticks: 200,
    gravity: 1.1,
    decay: 0.93,
    startVelocity: 28,
    shapes: ["circle", "square"],
  });
}

/**
 * Pricing section adapted from the 21st.dev "pricing" block to this project's
 * dark glass + emerald theme, THB currency, and per-branch subscription model.
 * A single highlighted plan is typical here (99 THB / month / branch).
 */
export function PricingSection({
  plans,
  title = "Simple, transparent pricing",
  description = "One plan. Pay per branch. Cancel anytime.",
  onSelectPlan,
  actionLoading = false,
}: PricingSectionProps) {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleSelect = (plan: PricingPlan, index: number) => {
    const el = buttonRefs.current[index];
    if (el) fireConfetti(el);
    onSelectPlan?.(plan);
  };

  return (
    <div className="py-10">
      <div className="text-center space-y-3 mb-10">
        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          {title}
        </h2>
        <p className="text-slate-400 text-base whitespace-pre-line max-w-xl mx-auto">
          {description}
        </p>
      </div>

      <div
        className={cn(
          "grid gap-6 justify-center",
          plans.length === 1
            ? "grid-cols-1 max-w-md mx-auto"
            : "grid-cols-1 md:grid-cols-3"
        )}
      >
        {plans.map((plan, index) => (
          <motion.div
            key={plan.name}
            initial={{ y: 30, opacity: 0 }}
            whileInView={{ y: 0, opacity: 1 }}
            viewport={{ once: true, margin: "-40px" }}
            transition={{ duration: 0.5, delay: index * 0.12, ease: "easeOut" }}
            className={cn(
              "relative rounded-3xl p-6 flex flex-col text-center",
              "bg-[#131522] border border-white/5",
              plan.isPopular && "border-emerald-500/40 shadow-lg shadow-emerald-500/10"
            )}
          >
            {plan.isPopular && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-emerald-500 text-[#052e1d] py-1 px-3 rounded-full flex items-center gap-1 text-xs font-bold shadow-md shadow-emerald-500/30">
                <Star className="h-3.5 w-3.5 fill-current" />
                <span>Most popular</span>
              </div>
            )}

            <div className="flex-1 flex flex-col">
              <p className="text-sm font-semibold text-slate-400">{plan.name}</p>

              <div className="mt-6 flex items-end justify-center gap-x-1.5">
                <span className="text-5xl font-bold tracking-tight text-white tabular-nums">
                  <NumberFlow
                    value={plan.price}
                    format={{
                      style: "currency",
                      currency: "THB",
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 0,
                    }}
                    transformTiming={{ duration: 500, easing: "ease-out" }}
                    willChange
                  />
                </span>
                <span className="text-sm font-medium text-slate-400 mb-1.5">
                  {plan.period}
                </span>
              </div>

              <p className="mt-2 text-xs text-slate-500">
                30-day free trial included
              </p>

              <ul className="mt-6 space-y-2.5 flex flex-col">
                {plan.features.map((feature, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-left">
                    <Check className="h-4 w-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                    <span className="text-sm text-slate-300">{feature}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-6 pt-5 border-t border-white/10">
                <button
                  ref={(el) => {
                    buttonRefs.current[index] = el;
                  }}
                  onClick={() => handleSelect(plan, index)}
                  disabled={actionLoading}
                  className={cn(
                    "w-full rounded-2xl py-3 px-4 text-sm font-semibold tracking-tight transition-all duration-300",
                    "transform-gpu hover:ring-2 hover:ring-emerald-400/50 hover:ring-offset-2 hover:ring-offset-[#131522]",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                    plan.isPopular
                      ? "bg-emerald-500 text-[#052e1d] hover:bg-emerald-400"
                      : "bg-white/5 text-slate-200 border border-white/10 hover:bg-white/10"
                  )}
                >
                  {actionLoading ? "Working…" : plan.buttonText}
                </button>
              </div>

              <p className="mt-4 text-xs leading-5 text-slate-500">
                {plan.description}
              </p>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
