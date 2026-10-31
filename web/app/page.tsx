"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import GlassmorphismCta from "@/components/ui/glassmorphism-cta";

export default function VantageLandingPage() {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [motionPending, setMotionPending] = useState(true);
  const [now, setNow] = useState<Date | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setMotionPending(false);
    }, 3500);
    return () => clearTimeout(timer);
  }, []);

  // Live clock in Asia/Bangkok (+07:00, no DST) — replaces the hardcoded mock
  // time. Updates every second so the header/menu always show the real time.
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const bkkTime = now
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Bangkok",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(now)
    : "—:—";
  const bkkDate = now
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Bangkok",
        day: "2-digit",
        month: "long",
        year: "numeric",
      }).format(now)
    : "";

  // High-End Interactive Emerald/Teal Financial Mesh & Particle Wave Background Animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };
    window.addEventListener("resize", handleResize);

    // Particle nodes representing multi-branch settlement streams
    const particles: Array<{ x: number; y: number; vx: number; vy: number; radius: number; alpha: number }> = [];
    const count = Math.min(width > 768 ? 70 : 35, 70);

    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.6,
        vy: (Math.random() - 0.5) * 0.6,
        radius: Math.random() * 2 + 1,
        alpha: Math.random() * 0.5 + 0.2,
      });
    }

    let mouseX = width / 2;
    let mouseY = height / 2;

    const handleMouseMove = (e: MouseEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    };
    window.addEventListener("mousemove", handleMouseMove);

    let step = 0;
    const render = () => {
      step += 0.008;
      ctx.clearRect(0, 0, width, height);

      // Deep cinematic dark gradient base
      const bgGrad = ctx.createRadialGradient(width * 0.5, height * 0.5, 50, width * 0.5, height * 0.5, Math.max(width, height));
      bgGrad.addColorStop(0, "#080c10");
      bgGrad.addColorStop(0.5, "#050505");
      bgGrad.addColorStop(1, "#020202");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      // Draw flowing emerald/teal financial wave curves
      ctx.save();
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.strokeStyle = i % 2 === 0 ? `rgba(16, 185, 129, ${0.12 - i * 0.02})` : `rgba(13, 148, 136, ${0.1 - i * 0.015})`;
        for (let x = 0; x < width; x += 15) {
          const y = height * 0.45 + Math.sin(x * 0.003 + step + i * 0.8) * 120 + Math.cos(x * 0.001 - step) * 60;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();

      // Update and draw particles & connection webs
      particles.forEach((p, idx) => {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;
        if (p.y < 0) p.y = height;
        if (p.y > height) p.y = 0;

        // Draw particle dot
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(16, 185, 129, ${p.alpha})`;
        ctx.fill();

        // Connect nearby particles and cursor
        for (let j = idx + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dx = p.x - p2.x;
          const dy = p.y - p2.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 130) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = `rgba(16, 185, 129, ${0.15 * (1 - dist / 130)})`;
            ctx.lineWidth = 0.75;
            ctx.stroke();
          }
        }

        // Connect to mouse pointer for interactivity
        const mdx = p.x - mouseX;
        const mdy = p.y - mouseY;
        const mdist = Math.sqrt(mdx * mdx + mdy * mdy);
        if (mdist < 160) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(mouseX, mouseY);
          ctx.strokeStyle = `rgba(52, 211, 153, ${0.25 * (1 - mdist / 160)})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      });

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("mousemove", handleMouseMove);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  const handleDemoAnimationEnd = () => {
    setMotionPending(false);
  };

  return (
    <div className={`fixed inset-0 overflow-hidden bg-[#050505] text-white select-none ${motionPending ? "motion-pending" : ""}`}>
      {/* Interactive Canvas Background Animation (Emerald / Teal / Dark Fintech Theme) */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-[-3] w-full h-full pointer-events-none select-none"
      />

      {/* Screen Vignette */}
      <div
        className="absolute inset-0 z-[-2] pointer-events-none"
        style={{
          background: `linear-gradient(180deg, rgba(5,5,5,.1), transparent 24%, transparent 82%, rgba(5,5,5,.3)), radial-gradient(ellipse at 44% 54%, transparent 20%, rgba(5,5,5,.4) 100%)`,
        }}
      />

      <div className="absolute inset-0 flex items-center justify-center w-full h-full">
        <div className="relative w-full h-full max-w-[1728px] max-h-[1117px] mx-auto">
          {/* Header (Top Bar) */}
          <header
            className={`absolute top-[clamp(20px,2.264vh,30px)] left-[clamp(36px,4.177vw,96px)] right-[clamp(36px,4.04vw,96px)] h-[48px] flex items-start whitespace-nowrap z-50 transition-all ${
              menuOpen ? "menu-open" : ""
            }`}
          >
            {/* Brand Logo */}
            <Link
              href="/"
              className="relative top-[10px] flex items-center group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 rounded"
              aria-label="Vantage home"
            >
              <div className="w-[28px] h-[28px] rounded-full bg-gradient-to-tr from-emerald-500 to-teal-500 shadow-[0_1px_8px_rgba(16,185,129,0.4)] flex items-center justify-center overflow-hidden">
                <svg viewBox="0 0 24 24" className="w-4 h-4 text-white" fill="currentColor">
                  <path d="M12 2L2 19h20L12 2zm0 4l6.5 11h-13L12 6z" />
                </svg>
              </div>
            </Link>

            {/* Nav */}
            <nav className="hidden lg:flex items-center ml-[clamp(36px,3.03vw,48px)] gap-[clamp(32px,2.9vw,43px)] relative top-[9px] text-[16px] font-[430] tracking-[-0.36px]">
              <Link href="/" className="relative text-white font-[500] pb-1 after:absolute after:bottom-0 after:left-0 after:w-[44px] after:h-[2px] after:bg-emerald-400 text-shadow-[0_1px_3px_rgba(0,0,0,.55)] transition-all hover:text-emerald-300">
                Home
              </Link>
              <Link href="/dashboard" className="relative text-[rgba(229,229,230,.77)] text-shadow-[0_1px_3px_rgba(0,0,0,.55)] transition-all hover:text-emerald-400">
                Dashboard
              </Link>
              <Link href="/reconciliation" className="relative text-[rgba(229,229,230,.77)] text-shadow-[0_1px_3px_rgba(0,0,0,.55)] transition-all hover:text-emerald-400">
                Reconciliation
              </Link>
              <Link href="/branches" className="relative text-[rgba(229,229,230,.77)] text-shadow-[0_1px_3px_rgba(0,0,0,.55)] transition-all hover:text-emerald-400 ml-[1px]">
                Branches
              </Link>
            </nav>

            {/* Time Panel */}
            <div className="hidden lg:flex items-center ml-auto w-[211px] h-[48px] pl-[8px] border-l-[2px] border-emerald-500/30">
              <div className="flex flex-col justify-center">
                <span className="text-[13px] font-[420] text-emerald-400/90 leading-none mb-1">Timezone (+07:00 BKK)</span>
                <span className="text-[14px] font-[440] text-[rgba(255,255,255,.93)] leading-none tracking-tight">
                  {bkkTime}&nbsp; • &nbsp;{bkkDate}
                </span>
              </div>
            </div>

            {/* Sign Up / Start Free */}
            <Link
              href="/register"
              className="hidden lg:flex items-center justify-center w-[115px] h-[42px] rounded-[9px] bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-[500] text-[15px] tracking-[-0.34px] shadow-[inset_0_1px_0_rgba(255,255,255,.3),0_4px_15px_rgba(16,185,129,0.3)] ml-[clamp(20px,1.95vw,29px)] transition-all hover:brightness-110 active:scale-95"
            >
              Sign Up
            </Link>

            {/* Menu Toggle for Tablet/Mobile */}
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="lg:hidden ml-auto flex items-center justify-center w-[46px] h-[46px] rounded-[11px] bg-black/60 border border-emerald-500/30 backdrop-blur-md text-white focus:outline-none"
              aria-label="Toggle navigation menu"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {menuOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 8h16M4 16h16" />
                )}
              </svg>
            </button>

            {/* Tablet / Mobile Dropdown Nav Panel */}
            {menuOpen && (
              <div className="absolute top-[60px] right-0 w-[min(324px,calc(100vw-48px))] rounded-[16px] p-6 bg-[rgba(12,16,22,0.95)] border border-emerald-500/30 backdrop-blur-[18px] shadow-2xl flex flex-col gap-4 lg:hidden z-50">
                <div className="text-xs font-mono text-emerald-400 uppercase tracking-widest pb-2 border-b border-white/10">
                  Your connected workspaces
                </div>
                <Link href="/" onClick={() => setMenuOpen(false)} className="text-white text-base font-medium hover:text-emerald-400 transition-colors">
                  Home
                </Link>
                <Link href="/dashboard" onClick={() => setMenuOpen(false)} className="text-slate-300 text-base font-medium hover:text-emerald-400 transition-colors">
                  Dashboard
                </Link>
                <Link href="/reconciliation" onClick={() => setMenuOpen(false)} className="text-slate-300 text-base font-medium hover:text-emerald-400 transition-colors">
                  Reconciliation
                </Link>
                <Link href="/branches" onClick={() => setMenuOpen(false)} className="text-slate-300 text-base font-medium hover:text-emerald-400 transition-colors">
                  Branches
                </Link>
                <div className="pt-2 border-t border-white/10 flex items-center justify-between text-xs text-slate-400">
                  <span>{bkkTime} • {bkkDate}</span>
                </div>
                <Link
                  href="/register"
                  onClick={() => setMenuOpen(false)}
                  className="w-full py-2.5 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-semibold text-center text-sm shadow-md"
                >
                  Sign Up / Get Started
                </Link>
              </div>
            )}
          </header>

          {/* Hero (Bottom Left) */}
          <section className="absolute left-0 right-0 sm:left-[clamp(36px,4.177vw,96px)] sm:right-auto bottom-[clamp(34px,5.19vh,64px)] flex flex-col items-start max-w-[680px] z-10 px-5 sm:px-0">
            {/* Headline */}
            <h1
              className="hero-title m-0 p-0 text-[clamp(34px,8.5vw,84px)] leading-[1.08] font-[500] tracking-[-1.2px] max-w-full"
              style={{
                fontFamily: '"Reference Display", "Reference Sans", Arial, sans-serif',
                WebkitTextStroke: ".12px currentColor",
                textShadow: "0 2px 4px rgba(0,0,0,.6)",
              }}
            >
              <span className="block overflow-hidden">
                <span className="block text-white scale-x-100 sm:scale-x-[.775] origin-left">
                  Stop Digging
                </span>
              </span>
              <span className="block overflow-hidden">
                <span className="block bg-gradient-to-r from-emerald-300 via-teal-200 to-emerald-400 bg-clip-text text-transparent scale-x-100 sm:scale-x-[.793] origin-left">
                  Delivery GP & Dashboards.
                </span>
              </span>
            </h1>

            {/* Body Copy */}
            <p
              className="mt-[clamp(15px,2.08vh,24px)] mb-[clamp(24px,3.11vh,36px)] text-[clamp(14px,4vw,19px)] leading-[clamp(19px,2.17vh,26px)] font-[350] tracking-[.13px] text-[rgba(226,229,228,.88)]"
              style={{ textShadow: "0 1px 3px rgba(0,0,0,.7)", width: "min(calc(100vw - 40px), 520px)" }}
            >
              Your restaurant sales & fees are scattered across Grab & LINE MAN.<br className="hidden sm:block" />
              Vantage bring them into one clear financial signal, so every<br className="hidden sm:block" />
              branch decision is backed by data you actually trust.
            </p>

            {/* Primary CTA */}
            <GlassmorphismCta
              label="Get Started"
              icon={<ArrowRight />}
              href="/dashboard"
              className="mt-[clamp(15px,2.08vh,24px)]"
            />
          </section>

          {/* Demo Card (Bottom Right) — hidden on mobile so it doesn't overlap hero */}
          <article
            onAnimationEnd={handleDemoAnimationEnd}
            className="hidden sm:flex absolute right-[clamp(36px,4.04vw,96px)] bottom-[clamp(34px,5.19vh,64px)] rounded-[clamp(12px,1.52vh,18px)] p-4 flex-col justify-between z-10"
            style={{
              width: "clamp(160px, 20vw, 225px)",
              aspectRatio: "201 / 265",
              border: "1px solid rgba(16,185,129,0.25)",
              background: "linear-gradient(145deg, rgba(16,22,26,0.9), rgba(5,12,16,0.95))",
              boxShadow: "0 10px 30px rgba(0,0,0,0.6), 0 0 0 2px rgba(16,185,129,0.1) inset, 0 0 20px rgba(16,185,129,0.08)",
              backdropFilter: "blur(18px) saturate(110%)",
            }}
          >
            {/* Demo Visual */}
            <div className="relative w-full aspect-square rounded-[12px] bg-gradient-to-br from-emerald-950/60 to-slate-950/80 border border-emerald-500/20 overflow-hidden flex items-center justify-center group cursor-pointer" onClick={() => router.push("/dashboard")}>
              <div className="absolute inset-0 bg-radial from-emerald-500/10 to-transparent" />
              <div className="absolute inset-0 flex flex-col items-center justify-center p-3 text-center">
                <span className="text-[10px] font-mono text-emerald-400 uppercase tracking-widest mb-1">Live Multi-Branch</span>
                <span className="text-xs font-bold text-white tracking-tight">Live workspace preview</span>
                <span className="text-[11px] text-slate-400 font-mono mt-1">Connect data to view payouts</span>
              </div>
              <button
                className="absolute w-12 h-12 rounded-full border border-emerald-400/40 bg-emerald-500/20 backdrop-blur-md flex items-center justify-center text-emerald-300 shadow-lg transition-transform group-hover:scale-110"
                aria-label="Play demo"
              >
                <svg className="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
            </div>

            {/* Watch Button */}
            <Link
              href="/dashboard"
              className="w-full py-2.5 rounded-[10px] text-center text-xs font-[450] text-white tracking-wide transition-all hover:brightness-110 flex items-center justify-center gap-1.5"
              style={{
                background: "linear-gradient(145deg, rgba(16,185,129,0.2), rgba(13,148,136,0.3))",
                border: "1px solid rgba(16,185,129,0.35)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2)",
              }}
            >
                <span>Open workspace</span>
              <svg className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </Link>
          </article>
        </div>
      </div>
    </div>
  );
}
