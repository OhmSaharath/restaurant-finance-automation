import { createClient } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/user-display";

/**
 * Client-side (RLS-scoped) identity read used by interactive components.
 *
 * Uses ONLY the browser session client (createClient from @/lib/supabase/client)
 * so the Service Role key never reaches the bundle. Mirrors the shape surfaced
 * by the server-side getTenantUserContext() (including filtering out
 * "[ARCHIVED DUPLICATE]%" brands and ordering deterministically by created_at)
 * and reads auth user_metadata (full_name / avatar_url) for display.
 */
export interface CurrentUser {
  userId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  role: UserRole;
  brandName: string | null;
  brandLogoUrl: string | null;
}

const VALID_ROLES: string[] = ["owner", "admin", "manager", "accountant", "partner"];
const ARCHIVED_BRAND_PREFIX = "[ARCHIVED DUPLICATE]";

function readMetaString(
  meta: Record<string, unknown> | undefined,
  key: string
): string | null {
  const v = meta ? meta[key] : undefined;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    const user = data.user;

    const meta = (user.user_metadata as Record<string, unknown> | undefined) ?? {};
    const fullName = readMetaString(meta, "full_name");
    const avatarUrl = readMetaString(meta, "avatar_url");

    let role: UserRole = null;
    let brandName: string | null = null;
    let brandLogoUrl: string | null = null;
    const { data: buRows } = await supabase
      .from("brand_users")
      .select("role, created_at, brands(name, logo_url)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });

    const activeRow =
      (buRows || []).find((row: any) => {
        const b = Array.isArray(row.brands) ? row.brands[0] : row.brands;
        const name = typeof b?.name === "string" ? b.name : "";
        return !name.startsWith(ARCHIVED_BRAND_PREFIX);
      }) || (buRows && buRows.length > 0 ? buRows[0] : null);

    if (activeRow && typeof activeRow.role === "string" && VALID_ROLES.includes(activeRow.role)) {
      role = activeRow.role as UserRole;
    }
    const brandObj = activeRow
      ? Array.isArray((activeRow as any).brands)
        ? (activeRow as any).brands[0]
        : (activeRow as any).brands
      : null;
    brandName = brandObj?.name || null;
    brandLogoUrl = brandObj?.logo_url || null;

    return { userId: user.id, email: user.email || "", fullName, avatarUrl, role, brandName, brandLogoUrl };
  } catch {
    return null;
  }
}

/**
 * Tiny in-page refresh bus so Sidebar / Header react immediately when a profile
 * is edited on the Settings page, without introducing a full context provider.
 * Returns an unsubscribe function.
 */
const listeners = new Set<() => void>();

export function onUserUpdated(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function notifyUserUpdated(): void {
  listeners.forEach((cb) => cb());
}
