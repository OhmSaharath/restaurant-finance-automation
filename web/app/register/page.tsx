"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ShieldCheck, ArrowRight, Lock, Mail, Sparkles, Building2, User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function RegisterPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [brandName, setBrandName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg("");
    setSuccessMsg("");

    const supabase = createClient();

    try {
      // 1. Supabase Auth Sign Up
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            brand_name: brandName,
          }
        }
      });

      if (authError) {
        setErrorMsg(authError.message);
        setLoading(false);
        return;
      }

      const user = authData?.user;

      if (user) {
        // 2. Try to provision Brand record
        try {
          const { data: brandData, error: brandErr } = await supabase
            .from("brands")
            .insert({ name: brandName })
            .select()
            .single();

          if (brandErr) throw brandErr;

          const brandId = brandData.id;

          // 3. Try to assign owner role in brand_users
          const { error: userErr } = await supabase
            .from("brand_users")
            .insert({
              user_id: user.id,
              brand_id: brandId,
              role: "owner",
            });

          if (userErr) throw userErr;
        } catch (dbErr: any) {
          // Browser RLS intentionally blocks tenant creation. The first
          // authenticated server request provisions it with the service role.
          console.info("Tenant provisioning deferred to the authenticated server context:", dbErr?.message || dbErr);
        }

        setSuccessMsg(authData.session
          ? "Registration successful! Opening your workspace..."
          : "Check your email to confirm your account, then sign in to finish setup.");
        setTimeout(() => {
          router.push(authData.session ? "/dashboard" : "/login");
        }, 1000);
      } else {
        // Email confirmation is enabled: do not create a local bypass session.
        setSuccessMsg("Check your email to confirm your account, then sign in.");
        setTimeout(() => {
          router.push("/login");
        }, 1500);
      }
    } catch (err: any) {
      setErrorMsg(err.message || "An unexpected error occurred during signup.");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#0a0d14]">
      {/* Subtle background glow */}
      <div className="absolute inset-0 pointer-events-none opacity-10" style={{
        backgroundImage: "radial-gradient(circle at center, rgba(16, 185, 129, 0.15) 0%, transparent 60%)"
      }} />

      <div className="w-full max-w-md relative z-10">
        {/* Brand Header */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-white/5 border border-white/10 mb-4 shadow-xl hover:scale-105 transition-transform">
            <Sparkles className="w-7 h-7 text-emerald-400" />
          </Link>
          <h1 className="text-2xl font-black tracking-tight text-white uppercase">
            PRO<span className="text-emerald-400">FIT</span> RESTO
          </h1>
          <p className="text-xs text-slate-400 mt-1 uppercase tracking-widest font-bold">
            Create Restaurant Brand Workspace
          </p>
        </div>

        {/* Glassmorphic Card */}
        <div className="bg-[#11141b]/85 backdrop-blur-2xl rounded-3xl p-8 border border-white/10 shadow-2xl">
          <h2 className="text-base font-bold text-slate-200 mb-6 uppercase tracking-wider">
            Register Brand Account
          </h2>

          {errorMsg && (
            <div className="mb-5 p-3.5 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-xs font-semibold">
              {errorMsg}
            </div>
          )}

          {successMsg && (
            <div className="mb-5 p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs font-semibold">
              {successMsg}
            </div>
          )}

          <form onSubmit={handleRegister} className="space-y-4">
            <div>
              <label className="block text-[10px] font-extrabold text-slate-400 uppercase tracking-widest mb-2">
                Full Name
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-500 absolute left-3.5 top-3.5" />
                <input
                  type="text"
                  required
                  placeholder="Your full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 rounded-2xl text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all shadow-inner"
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-extrabold text-slate-400 uppercase tracking-widest mb-2">
                Restaurant Brand Name
              </label>
              <div className="relative">
                <Building2 className="w-4 h-4 text-slate-500 absolute left-3.5 top-3.5" />
                <input
                  type="text"
                  required
                  placeholder="e.g. แมวอ้วนต้มน้ำปลา"
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 rounded-2xl text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all shadow-inner"
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-extrabold text-slate-400 uppercase tracking-widest mb-2">
                Owner Email
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3.5" />
                <input
                  type="email"
                  required
                  placeholder="owner@brand.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 rounded-2xl text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all shadow-inner"
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-extrabold text-slate-400 uppercase tracking-widest mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-3.5" />
                <input
                  type="password"
                  required
                  minLength={6}
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 rounded-2xl text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all shadow-inner"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full mt-2 py-3.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-xs uppercase tracking-wider rounded-2xl transition-all shadow-lg shadow-emerald-500/10 flex items-center justify-center gap-2 group disabled:opacity-70 cursor-pointer"
            >
              <span>{loading ? "Creating Tenant..." : "Create Workspace"}</span>
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </button>
          </form>

          <div className="mt-5 pt-5 border-t border-white/10 text-center">
            <p className="text-xs text-slate-400">
              Already have an account?{" "}
              <Link
                href="/login"
                className="font-bold text-emerald-400 hover:text-emerald-300 transition-colors uppercase"
              >
                Sign in
              </Link>
            </p>
          </div>
        </div>

        <div className="mt-8 text-center flex items-center justify-center gap-2 text-xs text-slate-500 uppercase tracking-widest font-bold">
          <ShieldCheck className="w-4 h-4 text-emerald-500/80" />
          <span>RLS Tenant Context Encryption</span>
        </div>
      </div>
    </div>
  );
}
