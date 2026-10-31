import type { AnchorHTMLAttributes, CSSProperties } from "react";
import { RefreshCw, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type GlassmorphismCtaProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  label?: string;
  spread?: string;
  shimmerColor?: string;
  speed?: string;
  icon?: React.ReactNode;
  isLoading?: boolean;
};

/**
 * Reusable Glassmorphism primary action button.
 *
 * Adaptable for ANY primary action:
 *   - Sync: <GlassmorphismCta label="Sync Recent Delivery Emails" icon={<RefreshCw />} onClick={...} isLoading={isSyncing} />
 *   - Get Started: <GlassmorphismCta label="Get Started" icon={<ArrowRight />} href="/dashboard" />
 * When `isLoading` is set, the circular icon slot renders a spinning RefreshCw
 * and the button is visually disabled (click suppressed). Otherwise a custom
 * `icon` is shown inside the circular container.
 */
export default function GlassmorphismCta({
  label = "Action",
  spread = "90deg",
  shimmerColor = "rgba(255,255,255,0.6)",
  speed = "4s",
  icon,
  isLoading,
  className,
  href = "#",
  onClick,
  ...props
}: GlassmorphismCtaProps) {
  return (
    <a
      href={href}
      onClick={(event) => {
        if (href === "#") event.preventDefault();
        if (!isLoading) onClick?.(event);
      }}
      className={cn(
        "group isolate inline-flex cursor-pointer overflow-hidden transition-all duration-300 hover:scale-105 hover:shadow-[0_0_40px_8px_rgba(129,140,248,0.35)] rounded-full relative shadow-[0_8px_40px_rgba(129,140,248,0.25)]",
        isLoading && "opacity-70 cursor-not-allowed hover:scale-100 hover:shadow-[0_8px_40px_rgba(129,140,248,0.25)]",
        className,
      )}
      style={
        {
          "--spread": spread,
          "--shimmer-color": shimmerColor,
          "--radius": "9999px",
          "--speed": speed,
          "--cut": "1px",
          "--bg": "rgba(255, 255, 255, 0.05)",
        } as CSSProperties
      }
      {...props}
    >
      <div className="absolute inset-0">
        <div className="absolute inset-[-200%] w-[400%] h-[400%] [animation:rotate-gradient_var(--speed)_linear_infinite]">
          <div className="absolute inset-0 [background:conic-gradient(from_calc(270deg-(var(--spread)*0.5)),transparent_0,var(--shimmer-color)_var(--spread),transparent_var(--spread))]" />
        </div>
      </div>
      <div className="absolute rounded-full [background:var(--bg)] [inset:var(--cut)] backdrop-blur" />
      <div
        className="z-10 flex gap-3 sm:w-auto overflow-hidden text-sm font-medium text-white w-full pt-2.5 pr-5 pb-2.5 pl-5 relative items-center justify-center"
        style={{ borderRadius: "9999px" }}
      >
        <div
          className="absolute"
          style={{
            width: "200%",
            height: "200%",
            background:
              "linear-gradient(90deg, transparent, rgba(255,255,255,0.2), rgba(255,255,255,0.2), rgba(255,255,255,0.2), rgba(255,255,255,0.2), transparent)",
            animation: "borderBeamRotation 4s infinite linear",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
          }}
        />
        <div
          className="absolute"
          style={{
            inset: "1px",
            background: "rgba(10, 11, 20, 0.8)",
            borderRadius: "9999px",
            backdropFilter: "blur(8px)",
          }}
        />
        <span className="whitespace-nowrap relative z-10 font-sans">
          {label}
        </span>
        <span className="inline-flex items-center justify-center z-10 bg-white/10 w-7 h-7 rounded-full ml-1 relative">
          {isLoading ? (
            <RefreshCw className="w-3.5 h-3.5 text-white animate-spin" strokeWidth={2.5} />
          ) : icon ? (
            <div className="[&>svg]:w-3.5 [&>svg]:h-3.5 [&>svg]:text-white [&>svg]:stroke-[2.5]">
              {icon}
            </div>
          ) : null}
        </span>
      </div>
    </a>
  );
}