"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Settings, Shield, Mail, ChevronRight, Pencil, LogOut, UserPlus, Trash2, ImagePlus, X, Sparkles } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { createClient } from "@/lib/supabase/client";
import {
  fetchCurrentUser,
  onUserUpdated,
  notifyUserUpdated,
  type CurrentUser,
} from "@/lib/current-user";
import {
  roleLabel,
  deriveDisplayName,
  deriveInitials,
} from "@/lib/user-display";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // ~2 MB
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // ~2 MB
const MAX_LOGO_DIMENSION = 2048;
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export default function SettingsPage() {
  const router = useRouter();

  const [gmailStatus, setGmailStatus] = useState<{ connected: boolean; email?: string; sync_status?: string } | null>(null);

  // Authenticated identity (from auth user_metadata via the RLS session client).
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);

  // Profile edit form state.
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bucketNotice, setBucketNotice] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Workspace branding is separate from a user's personal avatar. Only an
  // owner/admin can change it; every member can see the current logo.
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [logoSaving, setLogoSaving] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoSuccess, setLogoSuccess] = useState<string | null>(null);

  // Workspace members are managed by owners/admins. Partners are intentionally
  // presented as read-only members and never receive an invite role that can
  // edit the underlying tenant data.
  const [members, setMembers] = useState<Array<{
    user_id: string;
    email: string;
    full_name: string | null;
    role: string;
    status: string;
  }>>([]);
  const [teamLoading, setTeamLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("partner");
  const [teamError, setTeamError] = useState<string | null>(null);
  const [teamSuccess, setTeamSuccess] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchCurrentUser().then((u) => {
      if (!active) return;
      setUser(u);
      setProfileLoading(false);
    });
    const off = onUserUpdated(async () => {
      const u = await fetchCurrentUser();
      if (!active) return;
      setUser(u);
      setProfileLoading(false);
    });

    // Read-only check of the brand-scoped Gmail integration for the status card.
    fetch("/api/integrations/google/status")
      .then((r) => (r.ok ? r.json() : { connected: false }) as any)
      .then((j: any) => setGmailStatus({ connected: !!j.connected, email: j.email, sync_status: j.sync_status }))
      .catch(() => setGmailStatus({ connected: false }));

    return () => {
      active = false;
      off();
    };
  }, []);

  const canManageTeam = user?.role === "owner" || user?.role === "admin";
  const canManageBrand = canManageTeam;

  const loadMembers = async () => {
    if (!canManageTeam) return;
    setTeamLoading(true);
    setTeamError(null);
    try {
      const response = await fetch("/api/team/members", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not load workspace members.");
      setMembers(Array.isArray(body.members) ? body.members : []);
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : "Could not load workspace members.");
    } finally {
      setTeamLoading(false);
    }
  };

  useEffect(() => {
    if (canManageTeam) void loadMembers();
  }, [canManageTeam]);

  const inviteMember = async () => {
    setTeamError(null);
    setTeamSuccess(null);
    const email = inviteEmail.trim();
    if (!email) {
      setTeamError("Please enter the partner's email address.");
      return;
    }
    setTeamLoading(true);
    try {
      const response = await fetch("/api/team/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not add this account.");
      setInviteEmail("");
      setTeamSuccess(body.invited ? "Invitation sent. The partner can accept it by email." : "Account added to this workspace.");
      await loadMembers();
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : "Could not add this account.");
    } finally {
      setTeamLoading(false);
    }
  };

  const removeMember = async (member: { user_id: string; email: string }) => {
    if (!window.confirm(`Remove ${member.email || "this member"} from the workspace?`)) return;
    setTeamError(null);
    setTeamSuccess(null);
    setTeamLoading(true);
    try {
      const response = await fetch("/api/team/members", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: member.user_id }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not remove this member.");
      setTeamSuccess("Workspace access removed.");
      await loadMembers();
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : "Could not remove this member.");
    } finally {
      setTeamLoading(false);
    }
  };

  const displayName = user ? deriveDisplayName(user.fullName, user.email) : "…";
  const displayRole = user ? roleLabel(user.role) : "…";
  const initials = user ? deriveInitials(user.fullName, user.email) : "··";

  const startEdit = () => {
    setError(null);
    setSuccess(null);
    setBucketNotice(null);
    setNameInput(user?.fullName || "");
    setAvatarFile(null);
    setPreviewUrl(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setError(null);
    setSuccess(null);
    setBucketNotice(null);
    setAvatarFile(null);
    setPreviewUrl(null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      setAvatarFile(null);
      setPreviewUrl(null);
      return;
    }
    if (!(file.type && file.type.startsWith("image/"))) {
      setError("Please choose an image file (JPEG, PNG, WebP, GIF, AVIF).");
      e.target.value = "";
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError("Avatar must be 2 MB or smaller.");
      e.target.value = "";
      return;
    }
    setError(null);
    setAvatarFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const handleLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reset = () => {
      e.target.value = "";
      setLogoFile(null);
      setLogoPreviewUrl(null);
    };
    if (!LOGO_TYPES.has(file.type)) {
      setLogoError("Workspace logo must be a PNG, JPG, or WebP image.");
      reset();
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("Workspace logo must be 2 MB or smaller.");
      reset();
      return;
    }

    // Keep oversized source images out of Storage. A square 512×512 PNG/WebP
    // is the best fit for the navigation icon, while up to 2048px is accepted.
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      if (image.width > MAX_LOGO_DIMENSION || image.height > MAX_LOGO_DIMENSION) {
        setLogoError(`Logo dimensions must be ${MAX_LOGO_DIMENSION}×${MAX_LOGO_DIMENSION}px or smaller.`);
        reset();
        return;
      }
      setLogoError(null);
      setLogoFile(file);
      setLogoPreviewUrl(URL.createObjectURL(file));
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setLogoError("Could not read that image. Please choose a PNG, JPG, or WebP file.");
      reset();
    };
    image.src = objectUrl;
  };

  const saveLogo = async () => {
    if (!logoFile) return;
    setLogoSaving(true);
    setLogoError(null);
    setLogoSuccess(null);
    try {
      const form = new FormData();
      form.set("file", logoFile);
      const response = await fetch("/api/brand/logo", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not save the workspace logo.");
      const fresh = await fetchCurrentUser();
      if (fresh) setUser(fresh);
      notifyUserUpdated();
      setLogoFile(null);
      setLogoPreviewUrl(null);
      const processing = body?.processing;
      setLogoSuccess(
        processing?.background_removed || processing?.cropped
          ? "Workspace logo updated and optimized."
          : "Workspace logo updated."
      );
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : "Could not save the workspace logo.");
    } finally {
      setLogoSaving(false);
    }
  };

  const removeLogo = async () => {
    if (!user?.brandLogoUrl || !window.confirm("Remove the workspace logo?")) return;
    setLogoSaving(true);
    setLogoError(null);
    setLogoSuccess(null);
    try {
      const response = await fetch("/api/brand/logo", { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not remove the workspace logo.");
      const fresh = await fetchCurrentUser();
      if (fresh) setUser(fresh);
      notifyUserUpdated();
      setLogoSuccess("Workspace logo removed.");
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : "Could not remove the workspace logo.");
    } finally {
      setLogoSaving(false);
    }
  };

  const saveProfile = async () => {
    setError(null);
    setSuccess(null);
    setBucketNotice(null);

    const name = nameInput.trim();
    if (!name) {
      setError("Display name cannot be empty.");
      return;
    }

    setSaving(true);
    try {
      const supabase = createClient();
      const metadata: Record<string, string> = { full_name: name };

      // 1) Upload avatar (if chosen) to the `avatars` bucket. Handle a missing
      //    bucket gracefully: keep updating the name, surface an advisory.
      if (avatarFile) {
        const ext = (avatarFile.name.split(".").pop() || "").toLowerCase();
        const safeExt = /^[a-z0-9]{1,6}$/.test(ext) ? ext : "jpg";
        const path = `avatars/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${safeExt}`;

        const { error: upErr } = await supabase.storage
          .from("avatars")
          .upload(path, avatarFile, { upsert: true, contentType: avatarFile.type || "image/jpeg" });

        if (upErr) {
          const msg = (upErr.message || "").toLowerCase();
          const code = String(
            (upErr as { code?: string; statusCode?: number }).code || (upErr as { statusCode?: number }).statusCode || ""
          ).toLowerCase();
          const bucketMissing = /bucket/.test(msg) || /not ?found/.test(msg) || code === "404";
          if (bucketMissing) {
            setBucketNotice(
              "Avatar upload skipped: the 'avatars' storage bucket is not configured. " +
                "Create it in Supabase (Storage > New bucket named 'avatars', set it Public) and try again — your display name is still saved."
            );
          } else {
            setSaving(false);
            setError(upErr.message || "Avatar upload failed. Please try again.");
            return;
          }
        } else {
          const { data } = supabase.storage.from("avatars").getPublicUrl(path);
          if (data && data.publicUrl) metadata.avatar_url = data.publicUrl;
        }
      }

      // 2) Persist display identity into Auth user_metadata.
      const { error: updateErr } = await supabase.auth.updateUser({ data: metadata });
      if (updateErr) {
        setSaving(false);
        setError(updateErr.message || "Could not update your profile.");
        return;
      }

      // 3) Reflect changes locally + notify Sidebar/Header.
      const fresh = await fetchCurrentUser();
      if (fresh) setUser(fresh);
      notifyUserUpdated();

      setSaving(false);
      setEditing(false);
      setAvatarFile(null);
      setPreviewUrl(null);
      if (!bucketNotice) setSuccess("Profile updated successfully.");
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : "Unexpected error while saving your profile.");
    }
  };

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  };

  const shownAvatar =
    previewUrl ||
    user?.avatarUrl ||
    null;

  return (
    <div className="min-h-screen flex bg-[#050505] text-slate-100 subtle-mesh-bg">
      <Sidebar />
      <main className="flex-1 w-full md:ml-64 px-4 md:px-8 py-6">
        <Header ownerName={user ? displayName : undefined} brandName={user?.brandName || undefined} />

        <div className="mb-6">
          <Link href="/dashboard" className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 mb-2">
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Dashboard</span>
          </Link>
          <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <Settings className="w-6 h-6 text-emerald-400" />
            <span>Settings & API Integration</span>
          </h1>
          <p className="text-xs text-slate-400">
            Manage Supabase multi-tenant credentials, delivery platform connections, and user permissions.
          </p>
        </div>

        {/* Prominent Integrations card */}
        <Link
          href="/settings/integrations"
          className="group block dark-glass rounded-3xl p-6 border border-white/10 hover:border-emerald-500/40 transition shadow-2xl"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-sky-500 to-blue-700 text-white flex items-center justify-center shadow-lg shadow-sky-500/20">
                <Mail className="w-7 h-7" />
              </div>
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  Email &amp; Delivery Integrations
                  <ChevronRight className="w-4 h-4 text-emerald-400 group-hover:translate-x-0.5 transition-transform" />
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Connect Gmail to auto-ingest Grab / LINE MAN settlement emails &amp; statements.
                </p>
              </div>
            </div>

            {/* Connection status badge */}
            <span
              className={`inline-flex items-center gap-1.5 text-[11px] font-bold rounded-full px-3 py-1 ${
                gmailStatus?.connected
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                  : "bg-white/5 text-slate-400 border border-white/10"
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${gmailStatus?.connected ? "bg-emerald-400 animate-pulse" : "bg-slate-500"}`} />
              {gmailStatus?.connected
                ? `Connected as ${gmailStatus.email || "…@gmail.com"}`
                : "Not Connected"}
            </span>
          </div>
        </Link>

        {/* Profile card */}
        <section className="mt-6 dark-glass rounded-3xl p-6 border border-white/10">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <span className="w-9 h-9 rounded-2xl bg-white/5 border border-white/10 text-emerald-400 flex items-center justify-center">
                <Pencil className="w-4 h-4" />
              </span>
              Your Profile
            </h2>
            {!editing && !profileLoading && (
              <button
                onClick={startEdit}
                className="py-2 px-3.5 bg-white/5 hover:bg-white/10 text-xs font-semibold text-slate-300 rounded-xl border border-white/10 transition-colors flex items-center gap-1.5"
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit profile
              </button>
            )}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">Your name, avatar, and role across the workspace.</p>

          {profileLoading ? (
            <div className="flex items-center gap-3 mt-5">
              <div className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 animate-pulse" />
              <div className="w-40 h-3 bg-white/10 rounded animate-pulse" />
            </div>
          ) : (
            <div className="flex items-start gap-4 mt-5">
              {/* Avatar */}
              <div className="shrink-0">
                {shownAvatar ? (
                  <img
                    src={shownAvatar}
                    alt={displayName}
                    className="w-16 h-16 rounded-2xl object-cover border border-white/10 shadow-lg"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-600 text-white flex items-center justify-center font-bold text-lg shadow-lg shadow-emerald-500/20">
                    {initials}
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="text-base font-bold text-white truncate">{displayName}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20">
                    {displayRole}
                  </span>
                </div>
                <p className="text-xs text-slate-400 truncate">{user?.email || "—"}</p>

                {/* Inline edit form */}
                {editing && (
                  <div className="mt-4 space-y-3">
                    <label className="text-[11px] font-semibold text-slate-400 block mb-1">Display name</label>
                    <input
                      type="text"
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      maxLength={80}
                      placeholder="Your name"
                      className="w-full px-3.5 py-2 bg-white/5 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition-all"
                    />
                    <label className="text-[11px] font-semibold text-slate-400 block mb-1">
                      Avatar <span className="text-slate-500">(image, up to 2 MB)</span>
                    </label>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleFileChange}
                      className="block w-full text-xs text-slate-400 border border-white/10 rounded-xl bg-white/5 p-2"
                    />
                  </div>
                )}

                {(error || bucketNotice || success) && !editing && (
                  <div
                    className={`mt-3 text-[11px] rounded-xl px-3 py-2 ${
                      error
                        ? "bg-red-500/10 text-red-400 border border-red-500/30"
                        : bucketNotice
                          ? "bg-amber-500/10 text-amber-400 border border-amber-500/30"
                          : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                    }`}
                  >
                    {error || bucketNotice || success}
                  </div>
                )}

                {editing && (
                  <div className="flex items-center gap-2.5 mt-4">
                    <button
                      onClick={saveProfile}
                      disabled={saving}
                      className="py-2 px-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl text-xs font-semibold shadow-md shadow-emerald-600/20 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {saving ? (
                        <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : null}
                      {saving ? "Saving…" : "Save changes"}
                    </button>
                    <button
                      onClick={cancelEdit}
                      disabled={saving}
                      className="py-2 px-3.5 bg-white/5 hover:bg-white/10 text-slate-300 rounded-xl text-xs font-semibold border border-white/10 transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    {saving ? (
                      <span className="text-[11px] text-slate-500">Updating auth profile…</span>
                    ) : null}
                  </div>
                )}
                {editing && (error || bucketNotice) && (
                  <div
                    className={`mt-3 text-[11px] rounded-xl px-3 py-2 ${
                      error
                        ? "bg-red-500/10 text-red-400 border border-red-500/30"
                        : "bg-amber-500/10 text-amber-400 border border-amber-500/30"
                    }`}
                  >
                    {error || bucketNotice}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Workspace logo */}
        <section className="mt-6 dark-glass rounded-3xl p-6 border border-white/10">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <span className="w-9 h-9 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 flex items-center justify-center">
                  <ImagePlus className="w-4 h-4" />
                </span>
                Workspace logo
              </h2>
              <p className="text-[11px] text-slate-400 mt-1">
                This logo appears in the sidebar for everyone in this workspace.
              </p>
            </div>
            {canManageBrand ? (
              <span className="text-[10px] px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 font-semibold">
                Owner-managed
              </span>
            ) : null}
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="w-20 h-20 rounded-3xl bg-gradient-to-tr from-emerald-500/20 to-teal-500/20 border border-white/10 flex items-center justify-center shrink-0 overflow-hidden">
              {logoPreviewUrl || user?.brandLogoUrl ? (
                <img
                  src={logoPreviewUrl || user?.brandLogoUrl || ""}
                  alt={`${user?.brandName || "Workspace"} logo preview`}
                  className="w-full h-full object-contain p-0.5"
                />
              ) : (
                <Sparkles className="w-7 h-7 text-emerald-300" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              {canManageBrand ? (
                <>
                  <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-semibold text-slate-200 cursor-pointer transition-colors">
                    <ImagePlus className="w-3.5 h-3.5 text-emerald-300" />
                    Choose logo
                    <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleLogoFileChange} className="sr-only" />
                  </label>
                  <p className="text-[11px] text-slate-500 mt-2">
                    PNG, JPG, or WebP · max 2 MB · up to 2048×2048 px · recommended 512×512 px (square). The system automatically removes simple edge backgrounds and empty padding; complex backgrounds are preserved.
                  </p>
                  {logoFile ? (
                    <div className="flex items-center gap-2 mt-3">
                      <button
                        type="button"
                        onClick={saveLogo}
                        disabled={logoSaving}
                        className="py-2 px-3.5 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-xl text-xs font-semibold disabled:opacity-50"
                      >
                        {logoSaving ? "Saving…" : "Save logo"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setLogoFile(null); setLogoPreviewUrl(null); }}
                        disabled={logoSaving}
                        className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-400 border border-white/10 disabled:opacity-50"
                        title="Cancel logo change"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : user?.brandLogoUrl ? (
                    <button
                      type="button"
                      onClick={removeLogo}
                      disabled={logoSaving}
                      className="mt-3 text-[11px] text-slate-400 hover:text-red-400 disabled:opacity-50"
                    >
                      Remove logo
                    </button>
                  ) : null}
                </>
              ) : (
                <p className="text-xs text-slate-400">Workspace branding is managed by the owner or an admin.</p>
              )}
              {(logoError || logoSuccess) ? (
                <p className={`mt-3 text-[11px] rounded-xl px-3 py-2 ${logoError ? "bg-red-500/10 text-red-400 border border-red-500/30" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"}`}>
                  {logoError || logoSuccess}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        {/* Workspace members */}
        {canManageTeam && (
          <section className="mt-6 dark-glass rounded-3xl p-6 border border-white/10">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <span className="w-9 h-9 rounded-2xl bg-sky-500/10 border border-sky-500/20 text-sky-300 flex items-center justify-center">
                    <UserPlus className="w-4 h-4" />
                  </span>
                  Workspace members
                </h2>
                <p className="text-[11px] text-slate-400 mt-1">
                  Invite a partner to view this workspace. Partner access is read-only.
                </p>
              </div>
              <span className="text-[10px] px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 font-semibold">
                Owner-managed
              </span>
            </div>

            <div className="flex flex-col md:flex-row gap-2 mb-4">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="partner@example.com"
                className="flex-1 px-3.5 py-2 bg-white/5 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                className="px-3 py-2 bg-[#131522] border border-white/10 rounded-xl text-xs text-slate-200 [color-scheme:dark]"
              >
                <option value="partner">Partner — view only</option>
                <option value="accountant">Accountant</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
              <button
                type="button"
                onClick={inviteMember}
                disabled={teamLoading}
                className="px-4 py-2 bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-500 hover:to-blue-500 text-white rounded-xl text-xs font-semibold disabled:opacity-50"
              >
                {teamLoading ? "Working…" : "Invite account"}
              </button>
            </div>

            {(teamError || teamSuccess) && (
              <div className={`mb-4 text-[11px] rounded-xl px-3 py-2 ${teamError ? "bg-red-500/10 text-red-400 border border-red-500/30" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"}`}>
                {teamError || teamSuccess}
              </div>
            )}

            {teamLoading && !members.length ? (
              <div className="text-xs text-slate-500 py-4">Loading members…</div>
            ) : (
              <div className="space-y-2">
                {members.map((member) => (
                  <div key={member.user_id} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/5">
                    <div className="min-w-0">
                      <div className="text-xs text-white truncate">{member.full_name || member.email || "Workspace member"}</div>
                      <div className="text-[10px] text-slate-500 truncate">{member.email || "—"}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] px-2 py-1 rounded-full bg-white/5 border border-white/10 text-slate-300">
                        {roleLabel(member.role)}{member.status === "invited" ? " · invited" : ""}
                      </span>
                      {member.role !== "owner" && (
                        <button
                          type="button"
                          onClick={() => removeMember(member)}
                          title="Remove access"
                          className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {!members.length && <div className="text-xs text-slate-500 py-3">No members found.</div>}
              </div>
            )}
          </section>
        )}

        {/* Account card */}
        <section className="mt-6 dark-glass rounded-3xl p-6 border border-white/10">
          <h2 className="text-base font-bold text-white mb-1">Account</h2>
          <p className="text-[11px] text-slate-400 mb-4">The signed-in account for this workspace.</p>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-slate-300 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              {user?.email || "…"}
            </span>
            {profileLoading ? null : (
              <button
                onClick={handleSignOut}
                className="py-2 px-4 bg-white/5 hover:bg-red-500/20 hover:text-red-400 text-slate-300 rounded-xl text-xs font-semibold border border-white/10 transition-colors flex items-center gap-1.5"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            )}
          </div>
        </section>

        {/* Tenant Security card */}
        <div className="mt-6 dark-glass rounded-3xl p-8 border border-white/10 text-center space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto">
            <Shield className="w-8 h-8" />
          </div>
          <h2 className="text-lg font-bold text-white">Tenant Security & Isolation Active</h2>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Logged in as {profileLoading ? "…" : `${displayName} (${displayRole})`}. Strict brand isolation enabled across all API endpoints.
          </p>
        </div>
      </main>
    </div>
  );
}
