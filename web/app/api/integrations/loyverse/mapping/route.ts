import { NextRequest, NextResponse } from "next/server";
import { getTenantUserContext, hasWorkspaceWriteAccess, resolveBrandId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/integrations/loyverse/mapping
 * Persist the store<->branch mapping + VAT toggle/rate for the resolved brand.
 *
 * DATA ISOLATION: every branch_id in store_branch_map is membership-checked
 * server-side against the branches the authenticated user actually owns
 * (branches WHERE brand_id IN ctx.brandIds). A branch_id that is NOT a member
 * is rejected with 400 — the client is never trusted blindly.
 *
 * VAT: vat_rate must be numeric (or null). If vat_enabled is true, a null/0
 * rate is rejected (an enabled VAT needs a rate).
 *
 * Rate limit: 10/min/IP (fixed-window, in-memory).
 */
export async function POST(req: NextRequest) {
  const rl = checkRateLimit(req, { max: 10, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfterMs ?? 60_000) / 1000)) } }
    );
  }

  try {
    const ctx = await getTenantUserContext();
    if (!ctx || !ctx.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!hasWorkspaceWriteAccess(ctx)) {
      return NextResponse.json({ error: "PARTNER_READ_ONLY" }, { status: 403 });
    }
    const brandId = resolveBrandId(ctx, null);
    if (!brandId) {
      return NextResponse.json({ error: "NO_TENANT_BRAND" }, { status: 403 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "INVALID_JSON", message: "Invalid JSON body." }, { status: 400 });
    }

    // ---- Validate store_branch_map shape ----
    const rawMap = Array.isArray(body?.store_branch_map) ? body.store_branch_map : [];
    const map: Array<{ store_id: string; store_name: string; branch_id: string }> = [];
    const seenStores = new Set<string>();
    for (const entry of rawMap) {
      const storeId = typeof entry?.store_id === "string" ? entry.store_id : "";
      const branchId = typeof entry?.branch_id === "string" ? entry.branch_id : "";
      if (!storeId || !branchId || seenStores.has(storeId)) {
        return NextResponse.json(
          { error: "INVALID_MAPPING", message: "Each store_branch_map entry needs a unique store_id and a branch_id." },
          { status: 400 }
        );
      }
      seenStores.add(storeId);
      map.push({ store_id: storeId, store_name: "", branch_id: branchId });
    }

    // ---- Server-side branch membership check ----
    // The config row is written to the single resolved brandId, so a branch_id
    // is honored ONLY if it belongs to THAT brand (not the user's other brands).
    const supabase = await createClient();
    const { data: branchRows, error: branchErr } = await supabase
      .from("branches")
      .select("id")
      .eq("brand_id", brandId);
    if (branchErr) {
      return NextResponse.json({ error: branchErr.message }, { status: 500 });
    }
    const allowedBranchIds = new Set<string>(
      (branchRows || []).map((b: any) => String(b.id))
    );
    for (const entry of map) {
      if (!allowedBranchIds.has(entry.branch_id)) {
        return NextResponse.json(
          { error: "FORBIDDEN_BRANCH", message: `branch_id ${entry.branch_id} is not a member of this brand's branches.` },
          { status: 400 }
        );
      }
    }

    // ---- Validate VAT ----
    const vatEnabled = body?.vat_enabled === true;
    let vatRate: number | null = null;
    if (body?.vat_rate !== null && body?.vat_rate !== undefined && body?.vat_rate !== "") {
      if (
        typeof body.vat_rate !== "number" ||
        !Number.isFinite(body.vat_rate) ||
        body.vat_rate < 0 ||
        body.vat_rate > 999.99
      ) {
        return NextResponse.json(
          { error: "INVALID_VAT_RATE", message: "vat_rate must be a finite number between 0 and 999.99." },
          { status: 400 }
        );
      }
      vatRate = body.vat_rate;
    }
    if (vatEnabled && (vatRate === null || vatRate <= 0)) {
      return NextResponse.json(
        { error: "VAT_RATE_REQUIRED", message: "VAT is enabled but no (positive) rate was provided." },
        { status: 400 }
      );
    }

    // ---- Validate item_selection shape (optional) ----
    // Absent  -> keep the existing persisted selection untouched (no overwrite).
    // Present -> replace it wholesale. Each entry must be { item_id, include }
    // with a non-empty item_id and a strict boolean include, and unique item_id
    // (mirror the strictness of store_branch_map: malformed input is rejected).
    let finalItemSelection: Array<{ item_id: string; include: boolean }> | null = null;
    if (body?.item_selection !== undefined) {
      if (!Array.isArray(body.item_selection)) {
        return NextResponse.json(
          { error: "INVALID_ITEM_SELECTION", message: "item_selection must be an array." },
          { status: 400 }
        );
      }
      const selection: Array<{ item_id: string; include: boolean }> = [];
      const seenItems = new Set<string>();
      for (const entry of body.item_selection) {
        const itemId = typeof entry?.item_id === "string" ? entry.item_id : "";
        if (!itemId || typeof entry?.include !== "boolean" || seenItems.has(itemId)) {
          return NextResponse.json(
            { error: "INVALID_ITEM_SELECTION", message: "Each item_selection entry needs a unique item_id and a boolean include." },
            { status: 400 }
          );
        }
        seenItems.add(itemId);
        selection.push({ item_id: itemId, include: entry.include });
      }
      finalItemSelection = selection;
    }

    // ---- Read the existing config row: token + store_name labels ----
    //
    // DATA GUARD: the config row has a NOT NULL encrypted_access_token. A mapping
    // save must NEVER produce (or update to) a row lacking the token. The token is
    // written earlier by /save; here we read it back and refuse to write unless it
    // exists, so an upsert can never hit the NOT NULL constraint on INSERT nor null
    // it out on UPDATE. The token is used only as-is for the upsert and is never
    // logged or returned.
    const admin = createAdminClient();
    const { data: existing, error: existingErr } = await admin
      .from("loyverse_config")
      .select("store_branch_map, encrypted_access_token")
      .eq("brand_id", brandId)
      .maybeSingle();
    if (existingErr) {
      return NextResponse.json({ error: existingErr.message }, { status: 500 });
    }
    const encryptedToken = existing?.encrypted_access_token;
    if (!existing || typeof encryptedToken !== "string" || encryptedToken.length === 0) {
      return NextResponse.json(
        {
          error: "TOKEN_REQUIRED",
          message: "Save a Loyverse access token before mapping stores.",
        },
        { status: 400 }
      );
    }

    let existingNames: Record<string, string> = {};
    if (existing && Array.isArray(existing.store_branch_map)) {
      for (const e of existing.store_branch_map) {
        if (e && typeof e.store_id === "string") {
          existingNames[e.store_id] = typeof e.store_name === "string" ? e.store_name : "";
        }
      }
    }
    const finalMap = map.map((entry) => ({
      store_id: entry.store_id,
      store_name: existingNames[entry.store_id] || entry.store_name,
      branch_id: entry.branch_id,
    }));

    const { error } = await admin.from("loyverse_config").upsert(
      {
        brand_id: brandId,
        // Re-send the SAME token we just read so the ON CONFLICT update never
        // nulls it. The INSERT path cannot be reached here (guarded above).
        encrypted_access_token: encryptedToken,
        store_branch_map: finalMap,
        // item_selection is written ONLY when the field was present (explicitly
        // null keeps the existing selection intact on the ON CONFLICT update).
        ...(finalItemSelection === null ? {} : { item_selection: finalItemSelection }),
        vat_enabled: vatEnabled,
        ...(vatRate === null ? { vat_rate: null } : { vat_rate: vatRate }),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "brand_id" }
    );

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
