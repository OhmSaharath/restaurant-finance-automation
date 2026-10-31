/**
 * Loyverse REST API client (server-only).
 *
 * Base URL: https://api.loyverse.com/v1.0
 * Auth:     `Authorization: Bearer <token>` (Loyverse Personal Access Token,
 *           created in Back Office -> Settings -> Access Tokens).
 *
 * Phase 1 scope: catalog reads needed to bootstrap config — list stores for the
 * store<->branch mapping UI, test the token, and (future / Phase 3) list items
 * with variant cost for the item-selection UI. NO receipt sync yet.
 *
 * SECURITY: every function takes the token explicitly and NEVER logs it. On
 * failure they return a typed error object — they never throw the raw token
 * and never echo it into an error message. Do not add console.log of tokens.
 */

export const LOYVERSE_API_BASE = "https://api.loyverse.com/v1.0";

export interface LoyverseStore {
  id: string;
  name: string;
}

export interface LoyverseItemVariant {
  /** API field for a variant's id (Loyverse /items returns `variant_id`). */
  variant_id?: string;
  id?: string;
  cost?: number;
}

export interface LoyverseItem {
  id: string;
  /** API field for the item's display name (Loyverse /items returns `item_name`). */
  item_name?: string;
  handle?: string;
  name?: string;
  variants?: LoyverseItemVariant[];
}

export type TokenTestResult =
  | { ok: true; stores: LoyverseStore[] }
  | { ok: false; error: string };

/**
 * GET /stores — cursor-paginated list of the account's stores.
 * Loops `?limit=250` and follows the `cursor` body field until the final page
 * (Loyverse omits `cursor` on the last page).
 */
export async function listStores(token: string): Promise<LoyverseStore[]> {
  const stores: LoyverseStore[] = [];
  let cursor: string | null = null;
  // Safety cap so a runaway paginator can never loop forever.
  const MAX_PAGES = 50;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: "250" });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(`${LOYVERSE_API_BASE}/stores?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });

    if (!res.ok) {
      const err = new Error(
        `Loyverse /stores failed with status ${res.status}`
      ) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    const body: any = await res.json().catch(() => ({}));
    const batch: any[] = Array.isArray(body?.stores) ? body.stores : [];
    for (const s of batch) {
      if (s && typeof s.id === "string" && typeof s.name === "string") {
        stores.push({ id: s.id, name: s.name });
      }
    }

    cursor = typeof body?.cursor === "string" && body.cursor ? body.cursor : null;
    if (!cursor) break;
  }

  return stores;
}

/**
 * Wrapper around listStores that folds failures into a typed ok:false result.
 *  - 401/403 -> "invalid/expired token" (no token value ever echoed)
 *  - any other error -> ok:false with a generic message
 */
export async function testToken(
  token: string
): Promise<TokenTestResult> {
  try {
    const stores = await listStores(token);
    return { ok: true, stores };
  } catch (err: any) {
    const status = err?.status as number | undefined;
    if (status === 401 || status === 403) {
      return {
        ok: false,
        error: "Loyverse token is invalid or expired. Create a new Personal Access Token in Loyverse Back Office -> Settings -> Access Tokens.",
      };
    }
    return {
      ok: false,
      error: err?.message || "Could not reach the Loyverse API. Please try again.",
    };
  }
}

/**
 * GET /items — cursor-paginated list of catalog items (id + name + RESOLVED
 * variant cost). Resolves composite (recipe) items the same way the backend
 * does: a composite item's cost = SUM(component variant cost x quantity),
 * recursively. Otherwise a composite menu shows "no cost" and the item picker
 * under-reports what the owner actually keys.
 */
export async function listItems(token: string): Promise<LoyverseItem[]> {
  // Fetch the whole catalog first (2-pass cost resolution needs every variant).
  const raw: any[] = [];
  let cursor: string | null = null;
  const MAX_PAGES = 100;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: "250" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${LOYVERSE_API_BASE}/items?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const err = new Error(`Loyverse /items failed with status ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    const body: any = await res.json().catch(() => ({}));
    raw.push(...(Array.isArray(body?.items) ? body.items : []));
    cursor = typeof body?.cursor === "string" && body.cursor ? body.cursor : null;
    if (!cursor) break;
  }

  const parseCost = (v: any): number | undefined => {
    const c = typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : undefined;
    return c !== undefined && Number.isFinite(c) && c > 0 ? c : undefined;
  };

  // item_id -> { name, is_composite, variant_ids, components }
  const meta = new Map<string, any>();
  const variantOwner = new Map<string, string>();
  const directCost = new Map<string, number>(); // variant_id -> positive cost

  for (const item of raw) {
    if (!item || typeof item.id !== "string") continue;
    const name = item.item_name || item.handle || item.name || item.id;
    const vids: string[] = [];
    const comps = Array.isArray(item.components) ? item.components : [];
    meta.set(item.id, { name, is_composite: !!item.is_composite, vids, comps });
    for (const v of item.variants || []) {
      if (!v) continue;
      const vid = typeof v.variant_id === "string" ? v.variant_id : v.id;
      if (vid) { vids.push(vid); variantOwner.set(vid, item.id); }
      const c = parseCost(v.cost);
      if (c !== undefined && vid && !directCost.has(vid)) directCost.set(vid, c);
    }
  }

  // recursive resolve with cycle guard
  const resolved = new Map<string, number | undefined>();
  const resolve = (id: string, stack: Set<string>): number | undefined => {
    if (resolved.has(id)) return resolved.get(id);
    if (stack.has(id)) { resolved.set(id, undefined); return undefined; }
    const m = meta.get(id);
    if (!m) { resolved.set(id, undefined); return undefined; }
    stack.add(id);
    for (const vid of m.vids) {
      const d = directCost.get(vid);
      if (d !== undefined) { const r = round2(d); resolved.set(id, r); return r; }
    }
    if (m.is_composite && m.comps.length) {
      let total = 0;
      for (const comp of m.comps) {
        const vid = comp?.variant_id;
        const owner = vid ? variantOwner.get(vid) : undefined;
        if (!owner) { resolved.set(id, undefined); return undefined; }
        const qty = Number(comp?.quantity);
        if (!Number.isFinite(qty) || qty <= 0) { resolved.set(id, undefined); return undefined; }
        const sub = resolve(owner, stack);
        if (sub === undefined) { resolved.set(id, undefined); return undefined; }
        total += sub * qty;
      }
      const r = round2(total); resolved.set(id, r); return r;
    }
    resolved.set(id, undefined);
    return undefined;
  };
  for (const id of meta.keys()) resolve(id, new Set());

  // assemble result; backfill composite variant costs
  const variantsById = new Map<string, any[]>();
  for (const item of raw) {
    if (!item || typeof item.id !== "string") continue;
    variantsById.set(item.id, Array.isArray(item.variants) ? item.variants : []);
  }
  const items: LoyverseItem[] = [];
  for (const item of raw) {
    if (!item || typeof item.id !== "string") continue;
    const name = item.item_name || item.handle || item.name || item.id;
    const cost = resolved.get(item.id);
    const variants: LoyverseItemVariant[] = [];
    for (const v of item.variants || []) {
      if (!v) continue;
      const vid = typeof v.variant_id === "string" ? v.variant_id : v.id;
      const vc = cost !== undefined ? cost : parseCost(v?.cost);
      variants.push({
        ...(vid ? { variant_id: vid } : {}),
        ...(vc !== undefined ? { cost: vc } : {}),
      });
    }
    items.push({ id: item.id, name, ...(variants.length ? { variants } : {}) });
  }
  return items;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
