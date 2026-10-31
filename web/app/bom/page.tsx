"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChefHat,
  Check,
  FileUp,
  Info,
  Loader2,
  Plus,
  Receipt,
  Save,
  Scale,
  Upload,
  X,
  AlertTriangle,
  Merge,
} from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { formatTHB } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";

/* =============================================================================
   Recipe & BOM Costing — dual cost model (Phase 1)
   ------------------------------------------------------------
   Two independent cost models per menu item:
     (A) DIRECT cost  — the simple "Recommended for Delivery" model: price the
                        dish per serving directly on the menu item (cost column).
     (B) RECIPE BOM   — computed from ingredient lines: COGS = Σ(quantity ×
                        cost_per_unit), rounded to 2dp (round half up).

   Effective cost = DIRECT cost when set (> 0), otherwise the RECIPE BOM cost.

   All reads/writes go through createClient() — the browser RLS client. RLS
   already scopes every row to the authenticated user's brand(s), so there is
   NO service-role client and NO hardcoded brand_id here.
   ============================================================================= */

interface MenuItemRow {
  id: string;
  menu_code: string | null;
  name: string | null;
  selling_price: number | string | null;
  is_active: boolean | null;
  cost: number | string | null;
}

interface RecipeBomRow {
  menu_item_id: string;
  quantity: number | string;
  master_ingredients: { cost_per_unit: number | string } | null;
}

/** Response model of the FastAPI cost-scan preview endpoint (via our proxy). */
interface CostScanResult {
  status: string;
  columns: string[];
  name_column: string | null;
  cost_column: string | null;
  rows: { name: string; cost: number | null }[];
  row_count: number;
  needs_manual_mapping?: boolean;
  sample_rows?: Record<string, unknown>[];
}

/** An editable preview row in the import modal before confirmation. */
interface ImportRow {
  key: string;
  name: string;
  cost: string; // editable string; blank => no cost stored (never fabricate)
  selected: boolean;
}

/** Round a decimal to 2dp with round-half-up using exact BigInt math, matching
 *  app/reconciliation/cost_engine.py (ROUND_HALF_UP) with no IEEE-754 drift
 *  (the old Math.floor(x*100+0.5)/100 misrounded e.g. 1.005 -> 1.00). */
function roundHalfUpTo2dp(value: number | string): number {
  const s = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  const neg = s.startsWith("-");
  const abs = neg ? s.slice(1) : s;
  const [intStr = "0", fracRaw = ""] = abs.split(".");
  const frac = (fracRaw + "00").slice(0, 2);
  const third = (fracRaw + "0").slice(2, 3);
  let cents = BigInt(intStr) * 100n + BigInt(frac || "0");
  if (Number(third) >= 5) cents += 1n;
  const result = Number(cents) / 100;
  return neg ? -result : result;
}

/** Parse a NUMERIC(12,4) cell into an exact integer scaled to 1e4 (4dp). */
function toScaled4dp(v: number | string | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith("-");
  const abs = neg ? s.slice(1) : s;
  const [int = "0", frac = ""] = abs.split(".");
  const scaled = BigInt(int) * 10000n + BigInt((frac + "0000").slice(0, 4));
  return neg ? -scaled : scaled;
}

/** Round a BigInt total scaled to 1e8 (4dp qty x 4dp unit) half-up to 2dp THB. */
function roundHalfUpFrom1e8(total: bigint): number {
  const cents = (total + 500000n) / 1000000n; // +0.005 in 1e8 units; totals non-negative
  return Number(cents) / 100;
}

/** Parse a numeric DB cell; returns NaN for missing/malformed values (never fabricate 0). */
function asNumber(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return NaN;
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** True only when a value is a present, positive finite number. */
function hasCost(v: number): boolean {
  return Number.isFinite(v) && v > 0;
}

export default function RecipeBomPage() {
  const [menuItems, setMenuItems] = useState<MenuItemRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // "Add Menu Item" form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formCode, setFormCode] = useState("");
  const [formPrice, setFormPrice] = useState("");
  const [formCost, setFormCost] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Menu-cost file import (Phase 2) state
  const [showImport, setShowImport] = useState(false);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<CostScanResult | null>(null);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Merge duplicate menu items (Phase 3) state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Map menu_item_id -> computed BOM cost (2dp); absent when the item has no recipe.
  const bomCostById = useMemo(() => {
    return new Map<string, number>();
  }, []);

  useEffect(() => {
    let isMounted = true;

    const load = async () => {
      try {
        const supabase = createClient();

        const { data: items, error: itemsError } = await supabase
          .from("menu_items")
          .select("*")
          .order("name");

        if (itemsError) throw new Error(itemsError.message);
        if (!isMounted) return;

        // Fetch BOM lines joined to their ingredient unit cost (to-one FK).
        // master_ingredients(ingredient_id -> master_ingredients.id) exposes
        // cost_per_unit directly on each recipe line.
        const { data: boms, error: bomsError } = await supabase
          .from("recipe_boms")
          .select("menu_item_id, quantity, master_ingredients(cost_per_unit)");

        if (bomsError) throw new Error(bomsError.message);

        const itemRows: MenuItemRow[] = (items || []).map((r: any) => ({
          id: String(r.id),
          menu_code: r.menu_code,
          name: r.name,
          selling_price: r.selling_price,
          is_active: r.is_active,
          cost: r.cost,
        }));

        // Seed BOM cost accumulator per menu item.
        bomCostById.clear();
        const sums: Record<string, bigint> = {};
        (boms || []).forEach((line: any) => {
          const qty = toScaled4dp(line.quantity);
          const unit = toScaled4dp(line.master_ingredients?.cost_per_unit);
          if (qty === null || unit === null) return;
          const menuId = String(line.menu_item_id);
          sums[menuId] = (sums[menuId] || 0n) + qty * unit;
        });
        Object.entries(sums).forEach(([menuId, total]) => {
          bomCostById.set(menuId, roundHalfUpFrom1e8(total));
        });

        if (isMounted) setMenuItems(itemRows);
      } catch (err: any) {
        if (isMounted)
          setLoadError(err?.message || "Could not load menu items.");
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    load();
    return () => {
      isMounted = false;
    };
  }, [bomCostById]);

  /** Persist an edited direct cost via the RLS client." */
  const saveDirectCost = async (id: string, raw: string) => {
    const trimmed = raw.trim();
    // Empty -> clear the direct cost (fall back to BOM). Never fabricate 0.00.
    let next: number | null = null;
    if (trimmed !== "") {
      const parsed = asNumber(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setLoadError("Enter a valid non-negative cost, or leave it blank to clear.");
        return;
      }
      next = roundHalfUpTo2dp(trimmed);
    }

    setSavingId(id);
    setSavedId(null);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("menu_items")
        .update({ cost: next })
        .eq("id", id);
      if (error) throw new Error(error.message);

      setMenuItems((prev) =>
        prev.map((m) => (m.id === id ? { ...m, cost: next } : m))
      );
      const { [id]: _drop, ...rest } = drafts;
      setDrafts(rest);
      setSavedId(id);
      window.setTimeout(() => setSavedId(null), 1600);
    } catch (err: any) {
      setLoadError(err?.message || "Save failed.");
    } finally {
      setSavingId(null);
    }
  };

  const commitIfEnter = (
    e: React.KeyboardEvent<HTMLInputElement>,
    row: MenuItemRow
  ) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    }
  };

  // Auto-dismiss the success toast after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  // ---- Merge duplicate menu items (Phase 3) ----
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const selectedItems = menuItems.filter((m) => selectedIds.includes(String(m.id)));
  const mergeSelectedCount = selectedItems.length;

  /** Merge selected duplicates into one primary via the /api/menu-items/merge proxy. */
  const handleMerge = async () => {
    if (mergeSelectedCount < 2) return;
    // Primary = the first selected item that has a cost, else the first selected.
    const costed = selectedItems.filter((m) => hasCost(asNumber(m.cost)));
    const primary = costed[0] ?? selectedItems[0];
    const mergeIds = selectedItems
      .filter((m) => m.id !== primary.id)
      .map((m) => m.id);
    const primaryLabel = primary.name || primary.menu_code || primary.id;
    const confirmed = window.confirm(
      `Merge ${mergeIds.length} item(s) into "${primaryLabel}"? This repoints their sales and platform mappings to the primary and deletes the duplicates.`
    );
    if (!confirmed) return;

    setMerging(true);
    setMergeError(null);
    setToast(null);
    try {
      const res = await fetch("/api/menu-items/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primary_id: primary.id, merge_ids: mergeIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "Merge failed.");
      }
      setToast(
        `Merged ${data?.merged_count ?? mergeIds.length} item(s) into "${primaryLabel}".`
      );
      setSelectedIds([]);
      // Refresh from source of truth to keep ordering by name consistent.
      const supabase = createClient();
      const { data: items, error: itemsError } = await supabase
        .from("menu_items")
        .select("*")
        .order("name");
      if (itemsError) throw new Error(itemsError.message);
      setMenuItems(
        (items || []).map((r: any) => ({
          id: String(r.id),
          menu_code: r.menu_code,
          name: r.name,
          selling_price: r.selling_price,
          is_active: r.is_active,
          cost: r.cost,
        }))
      );
    } catch (err: any) {
      setMergeError(err?.message || "Merge failed.");
    } finally {
      setMerging(false);
    }
  };

  /** Scan an uploaded menu-cost file through our proxy (stateless preview). */
  const handleScanFile = async (file: File) => {
    if (!file) return;
    setScanLoading(true);
    setScanError(null);
    setScanResult(null);
    setImportRows([]);
    setToast(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/costs/scan", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "Could not scan the file.");
      }
      const result = data as CostScanResult;
      setScanResult(result);
      setImportRows(buildImportRows(result));
    } catch (err: any) {
      setScanError(err?.message || "Could not scan the file.");
    } finally {
      setScanLoading(false);
    }
  };

  const updateRow = (idx: number, patch: Partial<ImportRow>) => {
    setImportRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const toggleRow = (idx: number) => {
    setImportRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, selected: !r.selected } : r))
    );
  };
  const allSelected = importRows.length > 0 && importRows.every((r) => r.selected);
  const toggleAll = () => {
    setImportRows((prev) => prev.map((r) => ({ ...r, selected: !allSelected })));
  };
  const selectedCount = importRows.filter((r) => r.selected && r.name.trim() !== "").length;

  /** Insert the confirmed rows through the browser RLS client only. */
  const importSelected = async () => {
    const selected = importRows.filter((r) => r.selected && r.name.trim() !== "");
    if (selected.length === 0) return;
    setImporting(true);
    setScanError(null);
    setToast(null);
    try {
      const supabase = createClient();
      // Menu items require brand_id (NOT NULL, no default). RLS allows INSERT
      // only when brand_id belongs to the authenticated user, so resolve the
      // tenant brand id from the RLS-scoped brands table — never hardcoded.
      const { data: brands, error: brandsError } = await supabase
        .from("brands")
        .select("id")
        .not("name", "like", "[ARCHIVED DUPLICATE]%")
        .order("created_at")
        .limit(1);
      if (brandsError) throw new Error(brandsError.message);
      const brandId = brandOnly(brands);
      if (brandId === null) throw new Error("No brand is linked to your account yet.");

      const payloads: {
        brand_id: string;
        name: string;
        menu_code: string;
        cost: number | null;
      }[] = [];
      // Resolve the current menu master before inserting.  Re-importing the
      // same Grab/LINE MAN/Loyverse export must update the existing item, not
      // create another AUTO-* row.  The database unique key is the final
      // guard; this preflight also gives the user a useful successful result.
      const { data: existingRows, error: existingError } = await supabase
        .from("menu_items")
        .select("id,name,cost")
        .eq("brand_id", brandId);
      if (existingError) throw new Error(existingError.message);
      const existingByKey = new Map<string, { id: string; cost: number | null }>();
      for (const row of existingRows || []) {
        const key = canonicalMenuName(String(row.name || ""));
        if (key && !existingByKey.has(key)) {
          existingByKey.set(key, { id: String(row.id), cost: row.cost == null ? null : Number(row.cost) });
        }
      }
      const pendingByKey = new Map<string, (typeof payloads)[number]>();
      for (const r of selected) {
        const name = r.name.trim();
        const costTrim = r.cost.trim();
        // No fabricated costs: a blank cost input stays null in the DB.
        let cost: number | null = null;
        if (costTrim !== "") {
          const parsed = asNumber(costTrim);
          if (!Number.isFinite(parsed) || parsed < 0) {
            throw new Error(
              `Invalid cost "${r.cost}" for "${name}". Leave cost blank to import without a cost.`
            );
          }
          cost = roundHalfUpTo2dp(costTrim);
        }
        const key = canonicalMenuName(name);
        if (!key) continue;
        const existing = existingByKey.get(key);
        if (existing) {
          // A blank import cost never erases a known cost.  A supplied cost is
          // an explicit correction and is applied to the canonical row.
          if (cost !== null && (!Number.isFinite(existing.cost as number) || existing.cost !== cost)) {
            const { error: updateError } = await supabase
              .from("menu_items")
              .update({ cost })
              .eq("id", existing.id)
              .eq("brand_id", brandId);
            if (updateError) throw new Error(updateError.message);
            existing.cost = cost;
          }
          continue;
        }
        pendingByKey.set(key, { brand_id: brandId, name, menu_code: autoMenuCode(name), cost });
      }
      payloads.push(...pendingByKey.values());

      // Batch insert in chunks (Supabase can reject very large single inserts).
      const results = { ok: 0, failed: 0 };
      for (let i = 0; i < payloads.length; i += 100) {
        const chunk = payloads.slice(i, i + 100);
        // Supabase INSERT is atomic per statement: a chunk fully succeeds or fails.
        const { error } = await supabase.from("menu_items").insert(chunk);
        if (error) results.failed += chunk.length;
        else results.ok += chunk.length;
      }

      // Refresh from source of truth to keep ordering by name consistent.
      const { data: items, error: itemsError } = await supabase
        .from("menu_items")
        .select("*")
        .order("name");
      if (itemsError) throw new Error(itemsError.message);
      setMenuItems(
        (items || []).map((r: any) => ({
          id: String(r.id),
          menu_code: r.menu_code,
          name: r.name,
          selling_price: r.selling_price,
          is_active: r.is_active,
          cost: r.cost,
        }))
      );

      if (results.failed > 0) {
        setScanError(
          `Imported ${results.ok} of ${payloads.length} item(s); ${results.failed} failed. Review duplicates or invalid rows and retry the remainder.`
        );
        // keep the modal open for retry; table refreshed above from source of truth
        return;
      }

      setToast(`Imported ${payloads.length} menu item(s).`);
      setShowImport(false);
    } catch (err: any) {
      setScanError(err?.message || "Could not import the selected rows.");
    } finally {
      setImporting(false);
    }
  };

  const addMenuItem = async () => {
    const code = formCode.trim();
    if (code === "") {
      setFormError("Menu code is required.");
      return;
    }
    const name = formName.trim() || code;
    const priceNum = formPrice.trim() === "" ? null : asNumber(formPrice);
    const costNum = formCost.trim() === "" ? null : asNumber(formCost);
    if (priceNum !== null && (!Number.isFinite(priceNum) || priceNum < 0)) {
      setFormError("Selling price must be a valid non-negative number, or leave blank.");
      return;
    }
    if (costNum !== null && (!Number.isFinite(costNum) || costNum < 0)) {
      setFormError("Direct cost must be a valid non-negative number, or blank.");
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const supabase = createClient();
      // Menu items require brand_id (NOT NULL, no default). RLS allows INSERT
      // only when brand_id belongs to the authenticated user, so resolve the
      // tenant brand id from the RLS-scoped brands table — never hardcoded.
      const { data: brands, error: brandsError } = await supabase
        .from("brands")
        .select("id")
        .not("name", "like", "[ARCHIVED DUPLICATE]%")
        .order("created_at")
        .limit(1);
      if (brandsError) throw new Error(brandsError.message);
      const brandId = brandOnly(brands);
      if (brandId === null) {
        setFormError("No brand is linked to your account yet.");
        return;
      }

      const { data, error } = await supabase
        .from("menu_items")
        .insert({
          brand_id: brandId,
          menu_code: code,
          name,
          selling_price: formPrice.trim() === "" ? null : roundHalfUpTo2dp(formPrice),
          cost: formCost.trim() === "" ? null : roundHalfUpTo2dp(formCost),
        })
        .select("*")
        .single();
      if (error) throw new Error(error.message);

      // Refresh from source of truth to keep ordering by name consistent.
      const { data: items, error: itemsError } = await supabase
        .from("menu_items")
        .select("*")
        .order("name");
      if (itemsError) throw new Error(itemsError.message);
      setMenuItems((items || []).map((r: any) => ({
        id: String(r.id),
        menu_code: r.menu_code,
        name: r.name,
        selling_price: r.selling_price,
        is_active: r.is_active,
        cost: r.cost,
      })));

      setShowAddForm(false);
      setFormName("");
      setFormCode("");
      setFormPrice("");
      setFormCost("");
      void data; // inserted row; state refreshed above
    } catch (err: any) {
      setFormError(err?.message || "Could not add menu item.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-emerald-400 animate-spin mx-auto mb-3" />
          <p className="text-xs font-semibold text-slate-400">
            Loading menu items &amp; recipe BOM costs...
          </p>
        </div>
      </div>
    );
  }

  const emptyState =
    menuItems.length === 0 &&
    "No menu items yet — add your first menu item and its cost.";

  return (
    <div className="min-h-screen flex bg-[#050505] text-slate-100 subtle-mesh-bg">
      <Sidebar />
      <main className="flex-1 w-full md:ml-64 px-4 md:px-8 py-6">
        <Header />

        <div className="mb-6 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link
                href="/dashboard"
                className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Dashboard</span>
              </Link>
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <ChefHat className="w-6 h-6 text-emerald-400" />
              <span>Recipe &amp; BOM Costing</span>
            </h1>
            <p className="text-xs text-slate-400 max-w-2xl">
              Two cost models per dish: a simple per-dish{" "}
              <span className="text-emerald-400">Direct Cost</span> (Recommended
              for Delivery — most delivery restaurants price per-dish directly
              rather than maintaining an ingredient BOM) or a computed{" "}
              <span className="text-emerald-400">Recipe BOM</span> cost from your
              ingredient lines. The effective cost shown is the Direct Cost when
              set, otherwise the Recipe BOM cost.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="py-2.5 px-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-2xl text-xs font-semibold shadow-lg shadow-emerald-600/20 flex items-center gap-2 transition-all active:scale-95"
            >
              <Receipt className="w-4 h-4" />
              <span>Manage Recipes</span>
            </Link>
            {mergeSelectedCount >= 2 && (
              <button
                onClick={handleMerge}
                disabled={merging}
                className="py-2.5 px-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-2xl text-xs font-semibold shadow-lg shadow-emerald-600/20 flex items-center gap-1.5 transition-all disabled:opacity-50"
              >
                {merging ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Merge className="w-4 h-4" />
                )}
                <span>
                  {merging
                    ? `Merging ${mergeSelectedCount}…`
                    : `Merge selected (${mergeSelectedCount})`}
                </span>
              </button>
            )}
            <button
              onClick={() => setShowImport(true)}
              className="py-2.5 px-4 bg-white/5 hover:bg-white/10 text-slate-200 rounded-2xl text-xs font-semibold border border-white/10 shadow-sm flex items-center gap-1.5 transition-all"
            >
              <Upload className="w-4 h-4 text-emerald-400" />
              <span>Import Menu Items</span>
            </button>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="py-2.5 px-4 bg-white/5 hover:bg-white/10 text-slate-200 rounded-2xl text-xs font-semibold border border-emerald-500/20 shadow-sm flex items-center gap-1.5 transition-all"
            >
              <Plus className="w-4 h-4 text-emerald-400" />
              <span>Add Menu Item</span>
            </button>
          </div>
        </div>

        {loadError && (
          <div
            className="mb-4 dark-glass rounded-2xl p-3 border border-red-500/30 text-red-300 text-xs flex items-center gap-2"
            role="alert"
          >
            <span>{loadError}</span>
          </div>
        )}

        {toast && (
          <div
            className="mb-4 dark-glass rounded-2xl p-3 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2"
            role="status"
          >
            <Check className="w-4 h-4 shrink-0" />
            <span>{toast}</span>
          </div>
        )}

        {mergeError && (
          <div
            className="mb-4 dark-glass rounded-2xl p-3 border border-red-500/30 text-red-300 text-xs flex items-center gap-2"
            role="alert"
          >
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{mergeError}</span>
          </div>
        )}

        {/* Add Menu Item form */}
        {showAddForm && (
          <div className="mt-4 mb-6 dark-glass rounded-3xl p-6 border border-white/10 space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <Plus className="w-4 h-4 text-emerald-400" />
              <h2 className="text-sm font-bold text-white">
                Add Menu Item
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-400">
                  Menu Code *
                </span>
                <input
                  value={formCode}
                  onChange={(e) => setFormCode(e.target.value)}
                  placeholder="MAEW-101"
                  className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-400">
                  Name
                </span>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Dish name (defaults to code)"
                  className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-400">
                  Direct Cost (THB)
                </span>
                <input
                  value={formCost}
                  onChange={(e) => setFormCost(e.target.value)}
                  placeholder="e.g. 17.50"
                  inputMode="decimal"
                  className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-400">
                  Selling Price (THB)
                  <span className="ml-1 normal-case text-slate-500">(optional — platform-specific)</span>
                </span>
                <input
                  value={formPrice}
                  onChange={(e) => setFormPrice(e.target.value)}
                  placeholder="Leave blank"
                  inputMode="decimal"
                  className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                />
              </label>
            </div>
            {formError && (
              <p className="text-xs text-red-300">{formError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowAddForm(false)}
                className="py-2 px-4 bg-white/5 hover:bg-white/10 text-slate-300 rounded-2xl text-xs font-semibold border border-white/10"
              >
                Cancel
              </button>
              <button
                onClick={addMenuItem}
                disabled={submitting}
                className="py-2 px-4 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-2xl text-xs font-semibold shadow-lg shadow-emerald-600/20 flex items-center gap-2 disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5" />
                )}
                <span>{submitting ? "Adding..." : "Add Menu Item"}</span>
              </button>
            </div>
          </div>
        )}

        {/* Menu items table */}
        {emptyState ? (
          <div className="dark-glass rounded-3xl p-10 border border-white/10 text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto">
              <ChefHat className="w-8 h-8" />
            </div>
            <h2 className="text-base font-bold text-white">
              No menu items yet
            </h2>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              No menu items yet — add your first menu item and its cost.
            </p>
          </div>
        ) : (
          <div className="dark-glass rounded-3xl border border-white/10 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-400">
                  <th className="py-3 px-3 w-8"></th>
                  <th className="py-3 px-4">Menu Code</th>
                  <th className="py-3 px-4">Name</th>
                  <th className="py-3 px-4 text-right">Selling Price</th>
                  <th className="py-3 px-4">Direct Cost</th>
                  <th className="py-3 px-4 text-right">Recipe BOM Cost</th>
                  <th className="py-3 px-4 text-right">Effective Cost</th>
                </tr>
              </thead>
              <tbody>
                {menuItems.map((item) => {
                  const direct = asNumber(item.cost);
                  const bom = bomCostById.get(item.id);
                  const effective = hasCost(direct)
                    ? direct
                    : Number.isFinite(bom as number) ? (bom as number) : NaN;
                  const draft = drafts[item.id];

                  return (
                    <tr
                      key={item.id}
                      className="border-b border-white/5 hover:bg-white/5"
                    >
                      <td className="py-3 px-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(String(item.id))}
                          onChange={() => toggleSelect(String(item.id))}
                          aria-label={`Select ${item.name || item.menu_code || "item"} for merge`}
                          className="accent-emerald-500"
                        />
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-white/5 text-emerald-300 border border-emerald-500/20">
                          {item.menu_code || "—"}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-200">
                        {item.name || "—"}
                      </td>
                      <td className="py-3 px-4 text-right text-slate-300">
                        {(() => {
                          const sp = asNumber(item.selling_price);
                          return Number.isFinite(sp) && sp > 0 ? formatTHB(sp) : "—";
                        })()}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <div className="flex flex-col">
                            <span className="text-[9px] text-slate-500">
                              <span className="inline-flex items-center gap-1 text-emerald-400">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                Recommended for Delivery
                              </span>
                            </span>
                            <input
                              value={
                                draft !== undefined
                                  ? draft
                                  : Number.isFinite(direct)
                                    ? direct.toFixed(2)
                                    : ""
                              }
                              onChange={(e) =>
                                setDrafts({ ...drafts, [item.id]: e.target.value })
                              }
                              onBlur={(e) => {
                                // Only persist when the user actually edited this field.
                                if (drafts[item.id] !== undefined) {
                                  saveDirectCost(item.id, e.target.value);
                                }
                              }}
                              onKeyDown={(e) => commitIfEnter(e, item)}
                              placeholder="—"
                              inputMode="decimal"
                              aria-label={`Direct cost for ${item.name}`}
                              className="w-24 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                            />
                          </div>
                          {savingId === item.id ? (
                            <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
                          ) : savedId === item.id ? (
                            <Save className="w-3.5 h-3.5 text-emerald-400" />
                          ) : null}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {Number.isFinite(bom as number) ? (
                          <span className="flex items-center gap-1 justify-end">
                            <Scale className="w-3 h-3 text-slate-500" />
                            <span className="text-slate-300">
                              {formatTHB(bom as number)}
                            </span>
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-slate-500 border border-white/10">
                              Recipe BOM
                            </span>
                          </span>
                        ) : (
                          <span className="text-slate-600">No recipe</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-white">
                        {Number.isFinite(effective) ? (
                          formatTHB(effective)
                        ) : (
                          <span className="text-slate-500">No cost yet</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-[10px] text-slate-500">
          Costs are tenant-isolated via Row-Level Security. Direct costs are
          per-serving THB (Recommended for Delivery); the Recipe BOM cost is{"    "}
          Σ(quantity × cost per unit) rounded to 2dp. Missing costs are shown as
          — / “No cost yet” and are never estimated.
        </p>

        {/* Import Menu Items modal (Phase 2) */}
        {showImport && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="w-full max-w-3xl dark-glass rounded-3xl border border-white/10 flex flex-col max-h-[88vh] overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
                <div className="flex items-center gap-2">
                  <FileUp className="w-4 h-4 text-emerald-400" />
                  <h2 className="text-sm font-bold text-white">
                    Import Menu Items (Menu Cost)
                  </h2>
                </div>
                <button
                  onClick={() => setShowImport(false)}
                  className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300"
                  aria-label="Close import dialog"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                {/* Drop zone / file input */}
                <label className="flex flex-col items-center justify-center gap-2 w-full border-2 border-dashed border-white/10 hover:border-emerald-500/40 rounded-2xl py-8 cursor-pointer transition-colors bg-white/[0.02]">
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleScanFile(f);
                      e.target.value = "";
                    }}
                  />
                  <Upload className="w-6 h-6 text-emerald-400" />
                  <span className="text-xs text-slate-300">
                    Drop a menu-cost file here, or click to browse (.csv, .xlsx, .xls)
                  </span>
                  {scanLoading && (
                    <span className="text-[10px] text-emerald-400 flex items-center gap-1.5">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Scanning file…
                    </span>
                  )}
                </label>

                {scanError && (
                  <div
                    className="rounded-2xl p-3 border border-red-500/30 text-red-300 text-xs flex items-center gap-2"
                    role="alert"
                  >
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>{scanError}</span>
                  </div>
                )}

                {scanResult && !scanLoading && (
                  <>
                    <div className="rounded-2xl p-3 border border-emerald-500/20 bg-emerald-500/5 text-xs text-slate-300 flex items-start gap-2">
                      <Info className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      <span>
                        {scanResult.needs_manual_mapping
                          ? "Names could not be auto-detected — manual mapping is needed. Rows below use the first column as a starting name; edit freely before importing."
                          : (
                            <>
                              Auto-detected{" "}
                              <strong className="text-emerald-300">
                                {scanResult.name_column ?? "…"}
                              </strong>{" "}
                              as the name column
                              {scanResult.cost_column
                                ? (
                                  <>
                                    {" "}and{" "}
                                    <strong className="text-emerald-300">
                                      {scanResult.cost_column}
                                    </strong>{" "}
                                    as the cost column.
                                  </>
                                )
                                : " (no cost column found — costs are left blank for manual entry)."}
                            </>
                          )}
                      </span>
                    </div>

                    {importRows.length === 0 ? (
                      <div className="rounded-2xl p-8 border border-white/10 text-center text-xs text-slate-400">
                        No menu rows detected in this file.
                      </div>
                    ) : (
                      <div className="overflow-x-auto border border-white/10 rounded-2xl">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-white/[0.03] text-[10px] uppercase tracking-wider text-slate-400">
                            <tr className="border-b border-white/10">
                              <th className="py-2 px-3 w-8">
                                <input
                                  type="checkbox"
                                  checked={allSelected}
                                  onChange={toggleAll}
                                  aria-label="Select all rows"
                                />
                              </th>
                              <th className="py-2 px-3">Name</th>
                              <th className="py-2 px-3 w-36">Cost (THB)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {importRows.map((row, idx) => (
                              <tr key={row.key} className="border-b border-white/5 hover:bg-white/5">
                                <td className="py-2 px-3">
                                  <input
                                    type="checkbox"
                                    checked={row.selected}
                                    onChange={() => toggleRow(idx)}
                                    aria-label={`Select ${row.name || "row"}`}
                                  />
                                </td>
                                <td className="py-2 px-3">
                                  <input
                                    value={row.name}
                                    onChange={(e) => updateRow(idx, { name: e.target.value })}
                                    placeholder="Menu name"
                                    className="w-full bg-transparent text-white placeholder-slate-500 focus:outline-none"
                                  />
                                </td>
                                <td className="py-2 px-3">
                                  <input
                                    value={row.cost}
                                    onChange={(e) => updateRow(idx, { cost: e.target.value })}
                                    placeholder="—"
                                    inputMode="decimal"
                                    className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="px-6 py-4 border-t border-white/10 flex items-center justify-between gap-3">
                <span className="text-xs text-slate-400">
                  {importRows.length > 0
                    ? `${selectedCount} of ${importRows.length} selected`
                    : "No rows available"}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowImport(false)}
                    className="py-2 px-4 bg-white/5 hover:bg-white/10 text-slate-300 rounded-2xl text-xs font-semibold border border-white/10"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={importSelected}
                    disabled={importing || selectedCount === 0}
                    className="py-2 px-4 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-2xl text-xs font-semibold shadow-lg shadow-emerald-600/20 flex items-center gap-2 disabled:opacity-50"
                  >
                    {importing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Check className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {importing
                        ? `Importing ${selectedCount}…`
                        : `Import ${selectedCount} selected`}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/** Extract a single brand id from an RLS-scoped brands select. */
function brandOnly(brands: any): string | null {
  if (!Array.isArray(brands) || brands.length === 0) return null;
  const id = brands[0]?.id;
  return typeof id === "string" ? id : null;
}

/** Build editable import preview rows from a scan result. */
function buildImportRows(res: CostScanResult): ImportRow[] {
  const out: ImportRow[] = [];
  if (res.rows && res.rows.length > 0) {
    res.rows.forEach((r, i) => {
      out.push({
        key: `row-${i}-${r.name}`,
        name: r.name,
        cost: r.cost !== null && r.cost !== undefined ? String(r.cost) : "",
        selected: true,
      });
    });
    return out;
  }
  // Manual-mapping fallback: seed names from the first sample column so the
  // user still gets a usable (editable) preview even with no detected columns.
  if (res.needs_manual_mapping && res.sample_rows && res.sample_rows.length > 0) {
    const firstCol = res.columns?.[0] ?? "";
    res.sample_rows.forEach((r: any, i) => {
      const raw = typeof r?.[firstCol] === "string" ? r[firstCol] : "";
      out.push({ key: `sample-${i}`, name: (raw || "").trim(), cost: "", selected: true });
    });
  }
  return out;
}

/** Deterministic auto menu code generated from a display name. */
function autoMenuCode(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 8) || "item";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  // Full 32-bit hash space — the old % 1296 capped the suffix at 1296
  // buckets and collided (~16% of a 500-row Thai menu), violating the
  // (brand_id, menu_code) UNIQUE constraint. 7 base36 chars ~ 4B buckets.
  const suffix = h.toString(36).padStart(7, "0").toUpperCase();
  return `MI-${slug.toUpperCase()}-${suffix}`;
}

/** Canonical identity used by the BOM importer (not displayed to users). */
function canonicalMenuName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/\s+[—-]\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}
