"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  Store,
  Plus,
  Trash2,
  CheckCircle2,
  ArrowRight,
  Sparkles,
  Receipt,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

interface BranchFormItem {
  branchCode: string;
  branchName: string;
  address: string;
}

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [brandName, setBrandName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [branches, setBranches] = useState<BranchFormItem[]>([
    { branchCode: "", branchName: "", address: "" },
  ]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const cachedName = sessionStorage.getItem("onboarding_brand_name");
    if (cachedName) setBrandName(cachedName);
  }, []);

  const addBranch = () => {
    setBranches([
      ...branches,
      { branchCode: `BRANCH-${branches.length + 1}`, branchName: "", address: "" },
    ]);
  };

  const removeBranch = (index: number) => {
    if (branches.length > 1) {
      setBranches(branches.filter((_, i) => i !== index));
    }
  };

  const updateBranch = (index: number, field: keyof BranchFormItem, value: string) => {
    const updated = [...branches];
    updated[index][field] = value;
    setBranches(updated);
  };

  const handleFinishOnboarding = async () => {
    setLoading(true);
    setErrorMsg("");

    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      router.push("/login");
      return;
    }

    try {
      // 1. Insert Brand
      const { data: brandData, error: brandErr } = await supabase
        .from("brands")
        .insert({ name: brandName, tax_id: taxId || null })
        .select()
        .single();

      if (brandErr) throw brandErr;

      const newBrandId = brandData.id;

      // 2. Link User as Owner in brand_users
      const { error: userErr } = await supabase.from("brand_users").insert({
        user_id: user.id,
        brand_id: newBrandId,
        role: "owner",
      });

      if (userErr) throw userErr;

      // 3. Insert Branches
      const branchPayloads = branches
        .filter((b) => b.branchCode.trim() && b.branchName.trim())
        .map((b) => ({
          brand_id: newBrandId,
          branch_code: b.branchCode.trim(),
          branch_name: b.branchName.trim(),
          address: b.address.trim() || null,
        }));

      if (branchPayloads.length > 0) {
        const { error: branchErr } = await supabase
          .from("branches")
          .insert(branchPayloads);
        if (branchErr) throw branchErr;
      }

      sessionStorage.removeItem("onboarding_brand_name");
      router.push("/");
    } catch (err: any) {
      // A workspace is not usable until its tenant records are persisted.
      setErrorMsg(err?.message || "Could not save your workspace. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        {/* Wizard Progress */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold shadow-md">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900">Brand Onboarding Setup</h1>
              <p className="text-xs text-slate-500">Step {step} of 2</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div
              className={`w-8 h-2 rounded-full transition-all ${
                step >= 1 ? "bg-indigo-600" : "bg-slate-200"
              }`}
            />
            <div
              className={`w-8 h-2 rounded-full transition-all ${
                step === 2 ? "bg-indigo-600" : "bg-slate-200"
              }`}
            />
          </div>
        </div>

        {/* Wizard Card */}
        <div className="glass-card rounded-3xl p-8 border border-white/80 neo-inset">
          {errorMsg && (
            <div className="mb-5 p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-medium">
              {errorMsg}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-bold text-slate-800">Brand Information</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Set up your parent corporate entity for multi-tenant financial reporting.
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">
                    Official Brand Display Name *
                  </label>
                  <div className="relative">
                    <Building2 className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                    <input
                      type="text"
                      required
                      placeholder="e.g. แมวอ้วนต้มน้ำปลา"
                      value={brandName}
                      onChange={(e) => setBrandName(e.target.value)}
                      className="w-full pl-10 pr-4 py-3 bg-white/70 border border-slate-200 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">
                    Tax Identification Number (Optional)
                  </label>
                  <div className="relative">
                    <Receipt className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                    <input
                      type="text"
                      placeholder="e.g. 0105565012345"
                      value={taxId}
                      onChange={(e) => setTaxId(e.target.value)}
                      className="w-full pl-10 pr-4 py-3 bg-white/70 border border-slate-200 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                </div>
              </div>

              <div className="pt-4 flex justify-end">
                <button
                  type="button"
                  disabled={!brandName.trim()}
                  onClick={() => setStep(2)}
                  className="py-3 px-6 bg-slate-900 hover:bg-slate-800 text-white font-medium text-sm rounded-2xl transition-all shadow-md flex items-center gap-2 disabled:opacity-50"
                >
                  <span>Next: Configure Store Branches</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-800">Branch Locations</h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Add the store locations that receive delivery platform settlements.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={addBranch}
                  className="py-2 px-3 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Branch</span>
                </button>
              </div>

              <div className="space-y-3 max-h-[340px] overflow-y-auto pr-1">
                {branches.map((b, idx) => (
                  <div
                    key={idx}
                    className="p-4 bg-white/80 rounded-2xl border border-slate-200/80 shadow-sm flex items-center gap-3"
                  >
                    <div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center text-slate-600 shrink-0">
                      <Store className="w-4 h-4" />
                    </div>

                    <div className="grid grid-cols-3 gap-2 flex-1">
                      <input
                        type="text"
                        placeholder="Branch Code (e.g. MAEW-ST)"
                        value={b.branchCode}
                        onChange={(e) => updateBranch(idx, "branchCode", e.target.value)}
                        className="py-2 px-3 bg-slate-50/80 border border-slate-200 rounded-xl text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                      <input
                        type="text"
                        placeholder="Branch Name (e.g. สุทธิสาร)"
                        value={b.branchName}
                        onChange={(e) => updateBranch(idx, "branchName", e.target.value)}
                        className="py-2 px-3 bg-slate-50/80 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                      <input
                        type="text"
                        placeholder="Address / Note"
                        value={b.address}
                        onChange={(e) => updateBranch(idx, "address", e.target.value)}
                        className="py-2 px-3 bg-slate-50/80 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                    </div>

                    {branches.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeBranch(idx)}
                        className="p-2 text-slate-400 hover:text-red-500 rounded-xl transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="pt-4 flex items-center justify-between border-t border-slate-200/60">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="py-2.5 px-4 text-xs font-semibold text-slate-600 hover:text-slate-900"
                >
                  Back
                </button>

                <button
                  type="button"
                  disabled={loading}
                  onClick={handleFinishOnboarding}
                  className="py-3 px-6 bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-sm rounded-2xl transition-all shadow-md flex items-center gap-2 disabled:opacity-70"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{loading ? "Finalizing Workspace..." : "Complete Setup & Launch"}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
