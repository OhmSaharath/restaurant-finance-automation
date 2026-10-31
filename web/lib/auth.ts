import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface TenantUserContext {
  userId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  brandLogoUrl: string | null;
  brandId: string | null;
  /** The user's FULL brand set (one entry per brand_users row). */
  brandIds: string[];
  brandName: string | null;
  role: "owner" | "admin" | "manager" | "accountant" | "partner" | null;
  branches: Array<{ id: string; branchCode: string; branchName: string }>;
}

/** Default brand provisioned for a user who has no tenant relationship yet. */
export const DEFAULT_BRAND_NAME = "Workspace";

/**
 * Resolve the tenant brand_id for a request, honoring an explicitly requested
 * store ONLY when it is a member of the authenticated user's own brand set.
 * This is the single isolation chokepoint for any client-selected brand:
 *   - requested in the user's brandIds -> honored (member store)
 *   - requested "ALL" or absent        -> default to the primary brand
 *   - requested but NOT a member       -> never honored; falls through to primary
 * Returns null when the user has no brand at all (callers map that to 400/401/403).
 */
export function resolveBrandId(
  ctx: TenantUserContext,
  requested: string | null | undefined
): string | null {
  const brandIds = ctx.brandIds?.length ? ctx.brandIds : ctx.brandId ? [ctx.brandId] : [];
  if (requested && requested !== "ALL" && brandIds.includes(requested)) {
    return requested;
  }
  return ctx.brandId;
}

/** Partner memberships are deliberately read-only in all server mutations. */
export function hasWorkspaceWriteAccess(ctx: TenantUserContext | null): boolean {
  return !!ctx && ctx.role !== "partner";
}

/**
 * Auto-provision a default brand + owner membership for a user who has none.
 * Uses the Service Role (admin) client because RLS-scoped users cannot INSERT
 * into `brands` / `brand_users` (those are service-role-only per RLS).
 *
 * Safe to call repeatedly: if the user already has a brand, it is returned
 * unchanged. Returns the brand_id on success, or null on failure.
 */
export async function ensureTenantBrand(userId: string, requestedName?: string | null): Promise<string | null> {
  try {
    const admin = createAdminClient();

    // Already provisioned? -> return existing membership.
    const { data: existing } = await admin
      .from("brand_users")
      .select("brand_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (existing?.brand_id) {
      return String(existing.brand_id);
    }

    const normalizedName = typeof requestedName === "string" ? requestedName.trim().slice(0, 255) : "";
    const brandName = normalizedName || DEFAULT_BRAND_NAME;

    // Create the workspace only after the authenticated server context is known.
    const { data: brandRow, error: brandErr } = await admin
      .from("brands")
      .insert({ name: brandName })
      .select("id")
      .single();
    if (brandErr || !brandRow?.id) {
      console.warn("Auto-provision failed to create brand:", brandErr);
      return null;
    }
    const brandId = String(brandRow.id);

    // Grant the user owner role on the new brand.
    const { error: memberErr } = await admin.from("brand_users").insert({
      user_id: userId,
      brand_id: brandId,
      role: "owner",
    });
    if (memberErr) {
      console.warn("Auto-provision failed to create brand owner membership:", memberErr);
      return null;
    }

    return brandId;
  } catch (err) {
    console.warn("ensureTenantBrand caught error:", err);
    return null;
  }
}

export async function getTenantUserContext(): Promise<TenantUserContext | null> {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return null;
    }

    // Display identity comes from Supabase Auth user_metadata (no extra table).
    const meta = (user.user_metadata as Record<string, unknown> | undefined) ?? {};
    const fullName =
      typeof meta.full_name === "string" && meta.full_name.trim()
        ? meta.full_name.trim()
        : null;
    const avatarUrl =
      typeof meta.avatar_url === "string" && meta.avatar_url.trim()
        ? meta.avatar_url.trim()
        : null;
    const requestedBrandName =
      typeof meta.brand_name === "string" && meta.brand_name.trim()
        ? meta.brand_name.trim()
        : null;

    // Query tenant relationship — fetch ALL brand_users rows so a user who
    // belongs to multiple stores gets their FULL brand set. brandId / brandName
    // / role remain the FIRST row's values (primary/owner context) for backward
    // compatibility with the many existing ctx.brandId consumers.
    const { data: brandRows, error: brandUserError } = await supabase
      .from("brand_users")
      .select("brand_id, role, brands(id, name, logo_url)")
      .eq("user_id", user.id)
      .order("created_at");

    if (brandUserError) {
      console.warn("Tenant query warning:", brandUserError);
    }

    // Archived duplicate workspaces remain in the database for audit/recovery,
    // but must not appear in selectors or become a resolver scope.
    const brandUserRows = ((brandRows as any[] | null) ?? []).filter(
      (r: any) => !String((r?.brands as any)?.name || "").startsWith("[ARCHIVED DUPLICATE]")
    );
    const brandIds = brandUserRows
      .map((r: any) => r.brand_id)
      .filter((id: any) => id != null)
      .map(String);
    const brandId = brandIds[0] ?? null;
    const role = ((brandUserRows[0] as any)?.role as any) || null;
    const brandName = ((brandUserRows[0] as any)?.brands as any)?.name || null;
    const brandLogoUrl = ((brandUserRows[0] as any)?.brands as any)?.logo_url || null;

    // Graceful onboarding: an authenticated user with NO tenant brand gets a
    // neutral "Workspace" brand + owner membership auto-provisioned
    // (Service Role write; RLS users cannot INSERT brands/brand_users). This
    // replaces the NO_TENANT_BRAND dead-end across connect/sync/callback.
    if (!brandId) {
      const provisioned = await ensureTenantBrand(user.id, requestedBrandName);
      if (provisioned) {
        const { data: fresh } = await supabase
          .from("brand_users")
          .select("brand_id, role, brands(id, name, logo_url)")
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle();
        if (fresh?.brand_id) {
          const freshBrandId = String(fresh.brand_id);
          return {
            userId: user.id,
            email: user.email || "",
            fullName,
            avatarUrl,
            brandId: freshBrandId,
            brandIds: [freshBrandId],
            brandName: (fresh.brands as any)?.name || DEFAULT_BRAND_NAME,
            brandLogoUrl: (fresh.brands as any)?.logo_url || null,
            role: (fresh.role as any) || "owner",
            branches: [],
          };
        }
      }
      console.warn("Tenant brand auto-provision failed for user:", user.id);
    }

    let branches: Array<{ id: string; branchCode: string; branchName: string }> = [];

    if (brandIds.length) {
      const { data: branchRows } = await supabase
        .from("branches")
        .select("id, branch_code, branch_name")
        .in("brand_id", brandIds)
        .eq("is_active", true);

      if (branchRows) {
        branches = branchRows.map((b: any) => ({
          id: b.id,
          branchCode: b.branch_code,
          branchName: b.branch_name,
        }));
      }
    }

    return {
      userId: user.id,
      email: user.email || "",
      fullName,
      avatarUrl,
      brandId,
      brandIds,
      brandName,
      brandLogoUrl,
      role,
      branches,
    };
  } catch (err) {
    console.warn("getTenantUserContext caught error, returning fallback null:", err);
    return null;
  }
}

// Re-export the pure identity helpers for server consumers that prefer to import
// everything from "@/lib/auth". Client components MUST NOT import from this module
// (it drags the Service Role admin client into the bundle) — they use
// "@/lib/user-display" / "@/lib/current-user" instead.
export {
  roleLabel,
  deriveDisplayName,
  deriveInitials,
  emailLocalPart,
  type UserRole,
} from "@/lib/user-display";
