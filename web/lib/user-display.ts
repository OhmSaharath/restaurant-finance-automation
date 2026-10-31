/**
 * Pure, bundle-safe display helpers for user identity.
 *
 * Intentionally lives OUTSIDE lib/auth.ts: auth.ts imports the server client and
 * the Service Role (admin) client, so importing it from a client component would
 * drag SUPABASE_SERVICE_ROLE_KEY reachable code into the browser bundle. These
 * helpers are side-effect-free and safe to import anywhere (server or client).
 */
export type UserRole = "owner" | "admin" | "manager" | "accountant" | "partner" | null;

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  accountant: "Accountant",
  partner: "Partner (read-only)",
};

/** Map a brand_users role to a human label. null/unknown -> "Member". */
export function roleLabel(role: UserRole | string | null | undefined): string {
  if (!role) return "Member";
  return ROLE_LABELS[role] ?? "Member";
}

/** First segment of an email address ("khun.oh@x.com" -> "khun.oh"). */
export function emailLocalPart(email: string | null | undefined): string {
  if (!email) return "";
  return email.split("@")[0] || "";
}

/**
 * Friendly display name: fullName || email-local-part || "Owner".
 */
export function deriveDisplayName(
  fullName: string | null | undefined,
  email: string | null | undefined
): string {
  if (fullName && fullName.trim()) return fullName.trim();
  const local = emailLocalPart(email);
  if (local) return local;
  return "Owner";
}

/** Initials for the avatar fallback ("Khun Oh" -> "KO", "Owner" -> "OW"). */
export function deriveInitials(
  fullName: string | null | undefined,
  email: string | null | undefined
): string {
  const name = (fullName && fullName.trim()) || deriveDisplayName(fullName, email);
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}
