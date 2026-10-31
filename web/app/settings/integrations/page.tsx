"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Settings,
  Mail,
  PlugZap,
  Unplug,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Store,
  Wrench,
  Save,
  Key,
} from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";

interface IntegrationStatus {
  connected: boolean;
  email?: string;
  sync_status?: string;
  last_synced_at?: string | null;
}

interface LoyverseStatus {
  configured: boolean;
  enabled?: boolean;
  vat_enabled?: boolean;
  vat_rate?: number | null;
  store_branch_map?: Array<{ store_id: string; store_name?: string; branch_id?: string }>;
}

interface LoyverseStore {
  id: string;
  name: string;
}

interface LoyverseItemVariant {
  variant_id?: string;
  cost?: number;
}

interface LoyverseItem {
  id: string;
  name: string;
  variants?: LoyverseItemVariant[];
}

interface LoyverseItemSelectionEntry {
  item_id: string;
  include: boolean;
}

interface BranchOption {
  branch_id: string;
  branch_name: string;
}

export default function IntegrationsPage() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // --- Loyverse integration state (Advanced) ---
  const [loyStatus, setLoyStatus] = useState<LoyverseStatus | null>(null);
  const [loyLoaded, setLoyLoaded] = useState(false);
  const [loyToken, setLoyToken] = useState("");
  const [loyStores, setLoyStores] = useState<LoyverseStore[]>([]);
  const [loyBranches, setLoyBranches] = useState<BranchOption[]>([]);
  // store_branch_map: list aligned with loyStores, each entry a selected branch_id.
  const [loyMap, setLoyMap] = useState<{ store_id: string; store_name: string; branch_id: string }[]>([]);
  const [loyVatEnabled, setLoyVatEnabled] = useState(false);
  const [loyVatRate, setLoyVatRate] = useState<string>("");
  const [loyBusy, setLoyBusy] = useState(false);
  // Item selection (optional): the list of items loaded from the /items route
  // and a map of item_id -> include (true = included, i.e. flows into revenue/COGS).
  const [loyItems, setLoyItems] = useState<LoyverseItem[]>([]);
  const [loyItemInclude, setLoyItemInclude] = useState<Record<string, boolean>>({});
  const [loyItemsLoading, setLoyItemsLoading] = useState(false);

  // Carry the OAuth callback result (e.g. /settings/integrations?status=connected)
  // as an in-page toast notification. Read via window.location since this is a
  // client-rendered page (useSearchParams would bail out of prerender).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const statusParam = params.get("status");
    const message = params.get("message");
    if (statusParam === "connected") setToast("Gmail account connected successfully.");
    else if (statusParam === "error")
      setToast(`Connection failed${message ? `: ${message}` : "."}`);
  }, []);

  const loadStatus = async () => {
    try {
      const res = await fetch("/api/integrations/google/status");
      const json = await res.json();
      setStatus(json);
    } catch (err: any) {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  // ---- Loyverse: load config status + branch list on mount ----
  const loadLoyverse = async () => {
    try {
      const [statusRes, branchRes] = await Promise.all([
        fetch("/api/integrations/loyverse/status", { cache: "no-store" }),
        fetch("/api/analytics/branches?brand_id=ALL", { cache: "no-store" }),
      ]);
      const statusJson = await statusRes.json().catch(() => ({}));
      setLoyStatus(statusJson);

      const branchJson = await branchRes.json().catch(() => ({}));
      const branchList: BranchOption[] = Array.isArray(branchJson.branches)
        ? branchJson.branches.map((b: any) => ({
            branch_id: String(b.branch_id || ""),
            branch_name: String(b.branch_name || ""),
          }))
        : [];
      setLoyBranches(branchList);

      // Merge the saved map INTO the current loyMap (never replace): the list of
      // stores shown to the user is seeded from the /test result; the saved map
      // overlays any previously-persisted branch_id onto those store entries.
      // Replacing wholesale would wipe freshly-listed stores whose branch_id was
      // just picked but not yet persisted.
      const savedMap = Array.isArray(statusJson.store_branch_map)
        ? (statusJson.store_branch_map as Array<{ store_id: string; store_name?: string; branch_id?: string }>)
        : [];
      setLoyMap((prevMapped) => {
        const mergedByStore = new Map<
          string,
          { store_id: string; store_name: string; branch_id: string }
        >();
        for (const e of prevMapped) {
          mergedByStore.set(e.store_id, {
            store_id: e.store_id,
            store_name: e.store_name || "",
            branch_id: e.branch_id || "",
          });
        }
        for (const e of savedMap) {
          if (e && e.store_id) {
            const prev = mergedByStore.get(e.store_id);
            mergedByStore.set(e.store_id, {
              store_id: e.store_id,
              store_name: e.store_name || prev?.store_name || "",
              branch_id: e.branch_id || prev?.branch_id || "",
            });
          }
        }
        return Array.from(mergedByStore.values());
      });
      setLoyVatEnabled(statusJson.vat_enabled === true);
      setLoyVatRate(statusJson.vat_rate != null ? String(statusJson.vat_rate) : "");

      // Restore any previously-saved item selection toggles so a refresh keeps
      // the owner's choices. "Absent = include", so an untouched item defaults
      // to ON (true); only items the owner explicitly saved carry a record here.
      const savedSelection: LoyverseItemSelectionEntry[] = Array.isArray(statusJson.item_selection)
        ? (statusJson.item_selection as LoyverseItemSelectionEntry[])
        : [];
      if (savedSelection.length) {
        setLoyItemInclude((prev) => {
          const next = { ...prev };
          for (const s of savedSelection) {
            if (s && typeof s.item_id === "string" && s.item_id) {
              next[s.item_id] = s.include === true;
            }
          }
          return next;
        });
      }
    } catch {
      // ignore — card renders in "Not configured" state
    } finally {
      setLoyLoaded(true);
    }
  };

  useEffect(() => {
    loadLoyverse();
  }, []);

  // Save the pasted token, then test it and list the account's stores.
  const loySaveAndTest = async () => {
    const token = loyToken.trim();
    if (!token) {
      setToast("Paste a Loyverse access token first.");
      return;
    }
    setLoyBusy(true);
    try {
      const saveRes = await fetch("/api/integrations/loyverse/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: token }),
      });
      const saveJson = await saveRes.json().catch(() => ({}));
      if (!saveRes.ok) {
        setToast(`Save failed: ${saveJson.error || saveJson.message || "unknown error"}`);
        return;
      }
      const testRes = await fetch("/api/integrations/loyverse/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: token }),
      });
      const testJson = await testRes.json().catch(() => ({}));
      if (testJson.ok) {
        const stores: LoyverseStore[] = Array.isArray(testJson.stores)
          ? testJson.stores.map((s: any) => ({ id: String(s.id), name: String(s.name || "") }))
          : [];
        setLoyStores(stores);
        // Auto-seed mapping entries for any new store not yet mapped.
        setLoyMap((prev) => {
          const existing = new Map(prev.map((e) => [e.store_id, e]));
          const merged = stores.map((s) => existing.get(s.id) || { store_id: s.id, store_name: s.name, branch_id: "" });
          return merged;
        });
        setToast("Token saved and verified. Map each store to a branch below.");
        await loadLoyverse();
      } else {
        setToast(`Token saved but verification failed: ${testJson.error || "unknown error"}`);
      }
    } catch (err: any) {
      setToast(`Could not save token: ${err.message}`);
    } finally {
      setLoyBusy(false);
    }
  };

  // Test the currently pasted token (list stores) without saving.
  const loyTestOnly = async () => {
    setLoyBusy(true);
    try {
      const body = loyToken.trim() ? { access_token: loyToken.trim() } : {};
      const res = await fetch("/api/integrations/loyverse/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (json.ok) {
        const stores: LoyverseStore[] = Array.isArray(json.stores)
          ? json.stores.map((s: any) => ({ id: String(s.id), name: String(s.name || "") }))
          : [];
        setLoyStores(stores);
        setLoyMap((prev) => {
          const existing = new Map(prev.map((e) => [e.store_id, e]));
          return stores.map((s) => existing.get(s.id) || { store_id: s.id, store_name: s.name, branch_id: "" });
        });
        setToast(`Token verified — ${stores.length} Loyverse store(s) found.`);
      } else {
        setToast(`Verification failed: ${json.error || "unknown error"}`);
      }
    } catch (err: any) {
      setToast(`Verification failed: ${err.message}`);
    } finally {
      setLoyBusy(false);
    }
  };

  // Persist store<->branch mapping + VAT via /mapping.
  const loySaveMapping = async () => {
    if (!loyStores.length) {
      setToast("Test the token first to load the Loyverse stores.");
      return;
    }
    const incomplete = loyMap.some((e) => !e.branch_id);
    if (incomplete && window.confirm("Some Loyverse stores are not mapped to a branch. Save anyway?")) {
      // fall through — server stores only provided entries
    } else if (incomplete) {
      return;
    }
    const vatRate = loyVatRate.trim() === "" ? null : Number(loyVatRate);
    if (loyVatEnabled && (vatRate === null || isNaN(vatRate) || vatRate <= 0)) {
      setToast("Enter a valid VAT rate when VAT is enabled.");
      return;
    }
    setLoyBusy(true);
    try {
      const payload = {
        store_branch_map: loyMap
          .filter((e) => e.branch_id)
          .map((e) => ({ store_id: e.store_id, branch_id: e.branch_id })),
        vat_enabled: loyVatEnabled,
        vat_rate: vatRate,
      };
      const res = await fetch("/api/integrations/loyverse/mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setToast("Loyverse mapping & VAT settings saved.");
        await loadLoyverse();
      } else {
        setToast(`Save failed: ${json.error || json.message || "unknown error"}`);
      }
    } catch (err: any) {
      setToast(`Save failed: ${err.message}`);
    } finally {
      setLoyBusy(false);
    }
  };

  // Load the Loyverse catalog items so the owner can pick which flow into
  // revenue/COGS. Default every freshly-loaded item to INCLUDED (absent=include)
  // unless a previously-saved selection says otherwise.
  const loyLoadItems = async () => {
    setLoyItemsLoading(true);
    try {
      const res = await fetch("/api/integrations/loyverse/items", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (res.status === 429) {
        setToast(`Rate limit reached: ${json.message || json.error}`);
        return;
      }
      if (!json.ok) {
        setToast(json.configured === false
          ? (json.error || "No Loyverse token is saved for this brand.")
          : `Could not load items: ${json.error || json.message || "unknown error"}`);
        return;
      }
      const items: LoyverseItem[] = Array.isArray(json.items)
        ? json.items
            .filter((it: any) => it && typeof it.id === "string")
            .map((it: any) => ({
              id: String(it.id),
              name: typeof it.name === "string" ? it.name : "",
              variants: Array.isArray(it.variants)
                ? it.variants
                    .filter((v: any) => v && typeof v.variant_id === "string")
                    .map((v: any) => ({
                      variant_id: String(v.variant_id),
                      cost: typeof v.cost === "number" && Number.isFinite(v.cost) ? v.cost : undefined,
                    }))
                : [],
            }))
        : [];
      setLoyItems(items);
      // Merge defaults: an item not yet present in the map is included (ON).
      setLoyItemInclude((prev) => {
        const next = { ...prev };
        for (const it of items) {
          if (next[it.id] === undefined) next[it.id] = true;
        }
        return next;
      });
      setToast(`Loaded ${items.length} Loyverse item(s).`);
    } catch (err: any) {
      setToast(`Could not load items: ${err.message}`);
    } finally {
      setLoyItemsLoading(false);
    }
  };

  // Persist the item selection via /mapping, preserving the current mapping &
  // VAT state already on the page.
  const loySaveSelection = async () => {
    if (!loyItems.length) {
      setToast("Load the Loyverse items first.");
      return;
    }
    const itemSelection: LoyverseItemSelectionEntry[] = Object.entries(loyItemInclude).map(
      ([item_id, include]) => ({ item_id, include: include === true })
    );
    if (!itemSelection.length) {
      setToast("Load the Loyverse items first.");
      return;
    }
    const vatRate = loyVatRate.trim() === "" ? null : Number(loyVatRate);
    setLoyBusy(true);
    try {
      const payload = {
        store_branch_map: loyMap
          .filter((e) => e.branch_id)
          .map((e) => ({ store_id: e.store_id, branch_id: e.branch_id })),
        vat_enabled: loyVatEnabled,
        vat_rate: vatRate,
        item_selection: itemSelection,
      };
      const res = await fetch("/api/integrations/loyverse/mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setToast("Item selection saved.");
        await loadLoyverse();
      } else if (res.status === 429) {
        setToast(`Rate limit reached: ${json.message || json.error}`);
      } else {
        setToast(`Save failed: ${json.error || json.message || "unknown error"}`);
      }
    } catch (err: any) {
      setToast(`Save failed: ${err.message}`);
    } finally {
      setLoyBusy(false);
    }
  };

  // Disconnect (removes the stored config row).
  const loyDisconnect = async () => {
    if (!window.confirm("Disconnect Loyverse? The stored token and store-to-branch mapping for this brand will be removed."))
      return;
    setLoyBusy(true);
    try {
      const res = await fetch("/api/integrations/loyverse/disconnect", { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setToast("Loyverse integration disconnected.");
        setLoyStatus(null);
        setLoyStores([]);
        setLoyMap([]);
        setLoyVatEnabled(false);
        setLoyVatRate("");
      } else {
        setToast(`Disconnect failed: ${json.error || "unknown error"}`);
      }
    } catch (err: any) {
      setToast(`Disconnect failed: ${err.message}`);
    } finally {
      setLoyBusy(false);
    }
  };

  // Pull Loyverse now — forwards to FastAPI via the /sync proxy. The backend
  // takes no date range; it pulls whatever Loyverse returns (31-day window).
  const loySyncNow = async () => {
    setLoyBusy(true);
    try {
      const res = await fetch("/api/integrations/loyverse/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}), // brand_id auto-resolved server-side
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        const t = Number(json.total_receipts_ingested ?? 0);
        const r = Number(json.rows_upserted ?? 0);
        const skipped = Number(json.receipts_skipped_refund ?? 0);
        const note = json.note_31day_history;
        setToast(`Pulled ${t} receipts -> ${r} rows${skipped ? ` (${skipped} refunds skipped)` : ""}.${note ? ` ${note}` : ""}`);
        await loadLoyverse();
      } else if (res.status === 429) {
        setToast(`Rate limit reached: ${json.message || json.error}`);
      } else {
        setToast(`Pull failed: ${json.message || json.error || "unknown error"}`);
      }
    } catch (err: any) {
      setToast(`Pull failed: ${err.message}`);
    } finally {
      setLoyBusy(false);
    }
  };

  const connect = () => {
    window.location.href = "/api/integrations/google/connect";
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect Gmail? Settlement email auto-ingestion for this brand will stop."))
      return;
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/google/disconnect", { method: "DELETE" });
      const json = await res.json();
      if (res.ok) {
        setToast("Gmail integration disconnected.");
        setStatus({ connected: false });
      } else setToast(`Disconnect failed: ${json.error || "unknown error"}`);
    } catch (err: any) {
      setToast(`Disconnect failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/google/sync", { method: "POST" });
      const json = await res.json();
      if (res.ok) {
        const s = json.summary || {};
        setToast(
          `Sync complete: ${s.ingested_total || 0} record(s) ingested from ${s.attachments_downloaded || 0} attachment(s).`
        );
        await loadStatus();
      } else if (res.status === 429) {
        setToast(`Rate limit reached: ${json.message}`);
      } else {
        setToast(`Sync failed: ${json.message || json.error || "unknown error"}`);
      }
    } catch (err: any) {
      setToast(`Sync failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-[#050505] text-slate-100 subtle-mesh-bg">
      <Sidebar />
      <main className="flex-1 w-full md:ml-64 px-4 md:px-8 py-6">
        <Header />

        <div className="mb-6">
          <Link
            href="/settings"
            className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 mb-2"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Settings</span>
          </Link>
          <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <Settings className="w-6 h-6 text-emerald-400" />
            <span>Integrations</span>
          </h1>
          <p className="text-xs text-slate-400">
            Native Google OAuth &amp; Gmail settlement ingestion — replaces legacy Make.com webhooks.
          </p>
        </div>

        {/* Gmail Integration Card */}
        <div className="dark-glass rounded-3xl border border-white/10 overflow-hidden shadow-2xl">
          <div className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-sky-500 to-blue-700 text-white flex items-center justify-center shadow-lg shadow-sky-500/20">
                  <Mail className="w-7 h-7" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    Gmail Account Integration
                    {status?.connected ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                        <ShieldCheck className="w-3 h-3" />
                        <span>Connected</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-400 bg-white/5 border border-white/10 px-2 py-0.5 rounded-full">
                        <TriangleAlert className="w-3 h-3" />
                        <span>Not Connected</span>
                      </span>
                    )}
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    {status?.connected
                      ? `Connected as ${status.email || "...@gmail.com"}`
                      : "Connect a Gmail account to automatically ingest Grab / LINE MAN settlement emails."}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {status?.connected && (
                  <button
                    onClick={syncNow}
                    disabled={busy}
                    className="py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl text-xs font-semibold flex items-center gap-2 active:scale-95"
                  >
                    <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />
                    <span>Sync Now</span>
                  </button>
                )}
                {status?.connected ? (
                  <button
                    onClick={disconnect}
                    disabled={busy}
                    className="py-2.5 px-4 bg-white/5 hover:bg-red-500/20 hover:text-red-400 text-slate-200 rounded-2xl text-xs font-semibold border border-white/10 flex items-center gap-2"
                  >
                    <Unplug className="w-4 h-4" />
                    <span>Disconnect</span>
                  </button>
                ) : (
                  <button
                    onClick={connect}
                    disabled={busy || loading}
                    className="py-2.5 px-4 bg-gradient-to-r from-sky-600 to-blue-700 hover:from-sky-500 hover:to-blue-600 text-white rounded-2xl text-xs font-semibold flex items-center gap-2 active:scale-95"
                  >
                    <PlugZap className="w-4 h-4" />
                    <span>Connect Gmail Account</span>
                  </button>
                )}
              </div>
            </div>

            {status?.connected && (
              <div className="mt-5 border-t border-white/10 pt-4 grid grid-cols-2 gap-4 text-xs">
                <div className="dark-glass rounded-2xl p-3">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">Sync Status</p>
                  <p className="text-emerald-400 font-semibold mt-1 capitalize">
                    {status.sync_status || "idle"}
                  </p>
                </div>
                <div className="dark-glass rounded-2xl p-3">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">Last Synced</p>
                  <p className="text-slate-200 font-semibold mt-1">
                    {status.last_synced_at ? new Date(status.last_synced_at).toLocaleString() : "—"}
                  </p>
                </div>
              </div>
            )}


            <div className="mt-4 flex items-center gap-2 text-[10px] text-slate-500">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                Strict least-privilege scope: gmail.readonly only. Refresh tokens are AES-256-GCM
                encrypted at rest; sync is rate-limited to 5 requests/hour per brand.
              </span>
            </div>
          </div>
        </div>

        {/* Loyverse Integration Card (Advanced) */}
        <div className="dark-glass rounded-3xl border border-white/10 overflow-hidden shadow-2xl mt-6">
          <div className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-amber-500 to-orange-700 text-white flex items-center justify-center shadow-lg shadow-amber-500/20">
                  <Store className="w-7 h-7" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    Loyverse Integration (In-Store Sales)
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-full uppercase tracking-wider">
                      <Wrench className="w-3 h-3" />
                      Advanced
                    </span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Add in-store (storefront) sales as an extra revenue stream. Paste a Loyverse
                    Personal Access Token, verify it, and map each Loyverse store to one of your
                    branches.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    {loyStatus?.configured ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                        <ShieldCheck className="w-3 h-3" />
                        Configured
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-400 bg-white/5 border border-white/10 px-2 py-0.5 rounded-full">
                        <TriangleAlert className="w-3 h-3" />
                        Not configured
                      </span>
                    )}
                    <span className="text-[11px] text-slate-500">
                      {loyStatus?.configured && loyStatus.store_branch_map
                        ? `${loyStatus.store_branch_map.length} store(s) mapped`
                        : ""}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {loyStatus?.configured && (
                  <button
                    onClick={loySyncNow}
                    disabled={loyBusy}
                    className="py-2.5 px-4 bg-amber-600 hover:bg-amber-500 text-white rounded-2xl text-xs font-semibold flex items-center gap-2 active:scale-95"
                    title="Pull in-store receipt history from Loyverse now"
                  >
                    <RefreshCw className={`w-4 h-4 ${loyBusy ? "animate-spin" : ""}`} />
                    <span>Pull Loyverse Now</span>
                  </button>
                )}
                {loyStatus?.configured && (
                  <button
                    onClick={loyDisconnect}
                    disabled={loyBusy}
                    className="py-2.5 px-4 bg-white/5 hover:bg-red-500/20 hover:text-red-400 text-slate-200 rounded-2xl text-xs font-semibold border border-white/10 flex items-center gap-2"
                  >
                    <Unplug className="w-4 h-4" />
                    <span>Disconnect</span>
                  </button>
                )}
              </div>
            </div>

            {/* Token input + Save + Test */}
            <div className="mt-5 border-t border-white/10 pt-4">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">
                Loyverse Access Token
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex items-center gap-2 flex-1 dark-glass rounded-2xl px-3">
                  <Key className="w-4 h-4 text-amber-400 shrink-0" />
                  <input
                    type="password"
                    value={loyToken}
                    onChange={(e) => setLoyToken(e.target.value)}
                    placeholder="Paste your Loyverse Personal Access Token"
                    autoComplete="off"
                    className="bg-transparent w-full py-2.5 text-xs text-slate-200 placeholder-slate-500 outline-none"
                  />
                </div>
                <button
                  onClick={loySaveAndTest}
                  disabled={loyBusy}
                  className="py-2.5 px-4 bg-gradient-to-r from-amber-600 to-orange-700 hover:from-amber-500 hover:to-orange-600 text-white rounded-2xl text-xs font-semibold flex items-center gap-2 active:scale-95"
                >
                  <Save className="w-4 h-4" />
                  <span>Save &amp; Test</span>
                </button>
                <button
                  onClick={loyTestOnly}
                  disabled={loyBusy}
                  className="py-2.5 px-4 bg-white/5 hover:bg-white/10 text-slate-200 rounded-2xl text-xs font-semibold border border-white/10 flex items-center gap-2"
                >
                  <RefreshCw className={`w-4 h-4 ${loyBusy ? "animate-spin" : ""}`} />
                  <span>Test</span>
                </button>
              </div>
              <p className="mt-2 text-[10px] text-slate-500">
                Created in Loyverse Back Office -&gt; Settings -&gt; Access Tokens. The token is
                AES-256-GCM encrypted at rest and is never returned by any read endpoint.
              </p>
            </div>

            {/* Store -> branch mapping */}
            {loyStores.length > 0 && (
              <div className="mt-5 border-t border-white/10 pt-4">
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">
                  Map Loyverse Stores to Branches
                </p>
                {loyBranches.length === 0 && (
                  <p className="text-[11px] text-amber-300/80 mb-2">
                    No branches are available to map yet. Add branches first.
                  </p>
                )}
                <div className="space-y-2">
                  {loyStores.map((store) => {
                    const mapped = loyMap.find((e) => e.store_id === store.id);
                    return (
                      <div
                        key={store.id}
                        className="flex flex-col sm:flex-row sm:items-center gap-2 dark-glass rounded-2xl px-3 py-2"
                      >
                        <div className="flex-1">
                          <p className="text-xs font-semibold text-slate-200">
                            {store.name || store.id}
                          </p>
                          <p className="text-[10px] text-slate-500">Loyverse store</p>
                        </div>
                        <select
                          value={mapped?.branch_id || ""}
                          onChange={(e) => {
                            const branchId = e.target.value;
                            setLoyMap((prev) => {
                              const idx = prev.findIndex((entry) => entry.store_id === store.id);
                              // UPSERT: if the store has no entry yet (e.g. loyMap
                              // was reset before loadLoyverse re-seeded it), append
                              // one so the dropdown selection is recorded at all.
                              if (idx === -1) {
                                return [
                                  ...prev,
                                  { store_id: store.id, store_name: store.name || "", branch_id: branchId },
                                ];
                              }
                              return prev.map((entry, i) =>
                                i === idx ? { ...entry, branch_id: branchId } : entry
                              );
                            });
                          }}
                          className="bg-[#0a0a0a] border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 outline-none focus:border-amber-500/50 sm:w-64"
                        >
                          <option value="">Select a branch...</option>
                          {loyBranches.map((b) => (
                            <option key={b.branch_id} value={b.branch_id}>
                              {b.branch_name || b.branch_id}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Item selection (optional) */}
            {loyStatus?.configured && (
              <div className="mt-5 border-t border-white/10 pt-4">
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">
                  Item Selection (Optional)
                </p>
                <p className="text-[11px] text-slate-400 mb-3">
                  Choose which Loyverse menu items flow into revenue &amp; COGS. Items are included by
                  default; turn one off to exclude it.
                </p>

                {!loyItems.length && (
                  <button
                    onClick={loyLoadItems}
                    disabled={loyItemsLoading || loyBusy}
                    className="py-2.5 px-4 bg-white/5 hover:bg-white/10 text-slate-200 rounded-2xl text-xs font-semibold border border-white/10 flex items-center gap-2 active:scale-95"
                  >
                    <RefreshCw className={`w-4 h-4 ${loyItemsLoading ? "animate-spin" : ""}`} />
                    <span>Load Loyverse Items</span>
                  </button>
                )}

                {loyItemsLoading && !loyItems.length && (
                  <p className="text-xs text-slate-400 mt-3 flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin text-amber-400" />
                    Loading Loyverse items...
                  </p>
                )}

                {loyItems.length > 0 && (
                  <>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="max-h-72 overflow-y-auto flex-1 space-y-1.5 pr-1 dark-glass rounded-2xl p-3">
                        {loyItems.map((item) => {
                          const included = loyItemInclude[item.id] !== false;
                          return (
                            <label
                              key={item.id}
                              className="flex items-start gap-2 cursor-pointer rounded-xl px-2 py-1.5 hover:bg-white/5"
                            >
                              <input
                                type="checkbox"
                                checked={included}
                                onChange={() =>
                                  setLoyItemInclude((prev) => ({ ...prev, [item.id]: !included }))
                                }
                                className="accent-amber-500 w-4 h-4 mt-0.5 shrink-0"
                              />
                              <span className="flex-1">
                                <span
                                  className={`text-xs ${included ? "text-slate-200" : "text-slate-500 line-through"}`}
                                >
                                  {item.name || item.id}
                                </span>
                                {!!item.variants?.length && (
                                  <span className="block text-[10px] text-slate-500 mt-0.5">
                                    {item.variants
                                      .map((v) =>
                                        typeof v.cost === "number"
                                          ? `cost ${v.cost.toLocaleString("en-US", {
                                              minimumFractionDigits: 2,
                                              maximumFractionDigits: 2,
                                            })}`
                                          : "no cost"
                                      )
                                      .filter((x, i, arr) => arr.indexOf(x) === i)
                                      .join(", ")}
                                  </span>
                                )}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      <button
                        onClick={loyLoadItems}
                        disabled={loyItemsLoading || loyBusy}
                        title="Reload items from Loyverse"
                        className="py-2 px-3 bg-white/5 hover:bg-white/10 text-slate-300 rounded-2xl text-xs border border-white/10 flex items-center gap-2 self-start shrink-0"
                      >
                        <RefreshCw className={`w-4 h-4 ${loyItemsLoading ? "animate-spin" : ""}`} />
                        Reload
                      </button>
                    </div>
                    <button
                      onClick={loySaveSelection}
                      disabled={loyBusy || loyItemsLoading}
                      className="mt-4 py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl text-xs font-semibold flex items-center gap-2 active:scale-95"
                    >
                      <Save className="w-4 h-4" />
                      <span>Save Selection</span>
                    </button>
                  </>
                )}
              </div>
            )}

            {/* VAT toggle + rate */}
            <div className="mt-5 border-t border-white/10 pt-4">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={loyVatEnabled}
                    onChange={(e) => setLoyVatEnabled(e.target.checked)}
                    className="accent-amber-500 w-4 h-4"
                  />
                  <span>Apply VAT to in-store (storefront) sales</span>
                </label>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-400 shrink-0">VAT rate (%)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={loyVatRate}
                    disabled={!loyVatEnabled}
                    onChange={(e) => setLoyVatRate(e.target.value)}
                    placeholder="e.g. 7.00"
                    className="bg-[#0a0a0a] border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 outline-none w-28 disabled:opacity-40 disabled:cursor-not-allowed"
                  />
                </div>
              </div>
              <button
                onClick={loySaveMapping}
                disabled={loyBusy}
                className="mt-4 py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl text-xs font-semibold flex items-center gap-2 active:scale-95"
              >
                <Save className="w-4 h-4" />
                <span>Save Mapping &amp; VAT</span>
              </button>
            </div>

            <div className="mt-4 flex items-center gap-2 text-[10px] text-slate-500">
              <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
              <span>
                Store-to-branch mappings are membership-checked server-side; the access token is
                encrypted at rest and never logged. Receipt sync arrives in a later phase.
              </span>
            </div>
          </div>
        </div>
      </main>

      {/* Toast Notification */}
      {toast && (
        <div
          className="fixed bottom-6 right-6 z-50 max-w-sm px-4 py-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-semibold shadow-2xl animate-pulse"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
