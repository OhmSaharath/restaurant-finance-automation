import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTenantUserContext, resolveBrandId } from "@/lib/auth";

const INVITABLE_ROLES = new Set(["partner", "manager", "accountant", "admin"]);

type Membership = { id: string; user_id: string; role: string; created_at: string };

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function selectedBrandAndRole(requestedBrand: string | null) {
  const ctx = await getTenantUserContext();
  if (!ctx?.userId) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const brandId = resolveBrandId(ctx, requestedBrand);
  if (!brandId) return { error: NextResponse.json({ error: "No brand scope" }, { status: 403 }) };

  const supabase = await createClient();
  const { data: membership, error } = await supabase
    .from("brand_users")
    .select("role")
    .eq("user_id", ctx.userId)
    .eq("brand_id", brandId)
    .maybeSingle();
  if (error || !membership || !["owner", "admin"].includes(membership.role)) {
    return {
      error: NextResponse.json(
        { error: "Forbidden", message: "Only an owner or admin can manage workspace members." },
        { status: 403 }
      ),
    };
  }
  return { ctx, brandId, role: membership.role as string };
}

async function findAuthUserByEmail(admin: ReturnType<typeof createAdminClient>, email: string) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = data?.users || [];
    const found = users.find((u) => (u.email || "").toLowerCase() === email);
    if (found) return found;
    if (users.length < 1000) break;
  }
  return null;
}

async function memberResponse(brandId: string) {
  const admin = createAdminClient();
  const [{ data: memberships, error: membershipError }, { data: invitations, error: invitationError }] =
    await Promise.all([
      admin
        .from("brand_users")
        .select("id, user_id, role, created_at")
        .eq("brand_id", brandId)
        .order("created_at", { ascending: true }),
      admin
        .from("brand_invitations")
        .select("id, email, role, status, expires_at, created_at, auth_user_id")
        .eq("brand_id", brandId)
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
    ]);
  if (membershipError) throw membershipError;
  if (invitationError) throw invitationError;

  const memberList = (memberships || []) as Membership[];
  const uniqueUserIds = Array.from(new Set(memberList.map((m) => m.user_id).filter(Boolean)));
  const usersById = new Map<string, { email: string; full_name: string | null; confirmed: boolean }>();
  await Promise.all(
    uniqueUserIds.map(async (uid) => {
      const { data, error } = await admin.auth.admin.getUserById(uid);
      if (!error && data?.user) {
        const user = data.user;
        usersById.set(user.id, {
          email: user.email || "",
          full_name: typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : null,
          confirmed: !!user.email_confirmed_at,
        });
      }
    })
  );

  return {
    members: memberList.map((member) => ({
      id: member.id,
      user_id: member.user_id,
      role: member.role,
      created_at: member.created_at,
      email: usersById.get(member.user_id)?.email || "",
      full_name: usersById.get(member.user_id)?.full_name || null,
      status: usersById.get(member.user_id)?.confirmed === false ? "invited" : "active",
    })),
    invitations: invitations || [],
  };
}

export async function GET(request: NextRequest) {
  try {
    const access = await selectedBrandAndRole(new URL(request.url).searchParams.get("brand_id"));
    if (access.error) return access.error;
    return NextResponse.json(await memberResponse(access.brandId));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Could not load workspace members." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const access = await selectedBrandAndRole(typeof body.brand_id === "string" ? body.brand_id : null);
    if (access.error) return access.error;

    const email = normalizeEmail(body.email);
    const role = typeof body.role === "string" ? body.role : "partner";
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return NextResponse.json({ error: "Please provide a valid email address." }, { status: 400 });
    }
    if (!INVITABLE_ROLES.has(role)) {
      return NextResponse.json({ error: "Unsupported member role." }, { status: 400 });
    }

    const admin = createAdminClient();
    const found = await findAuthUserByEmail(admin, email);
    if (found) {
      const { data: existingMembership } = await admin
        .from("brand_users")
        .select("id, role")
        .eq("brand_id", access.brandId)
        .eq("user_id", found.id)
        .maybeSingle();
      if (existingMembership) {
        return NextResponse.json({ error: "This account is already a member of the workspace." }, { status: 409 });
      }
    }

    const { data: pending } = await admin
      .from("brand_invitations")
      .select("id")
      .eq("brand_id", access.brandId)
      .eq("email_normalized", email)
      .eq("status", "pending")
      .maybeSingle();
    if (pending) {
      return NextResponse.json({ error: "An invitation for this email is already pending." }, { status: 409 });
    }

    let authUserId = found?.id || null;
    let status = "accepted";
    if (!found) {
      const origin = request.headers.get("origin") || new URL(request.url).origin;
      const { data: invite, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { invited_brand_id: access.brandId, invited_role: role },
        redirectTo: `${origin}/auth/callback`,
      });
      if (inviteError || !invite.user) {
        return NextResponse.json({ error: inviteError?.message || "Could not send invitation." }, { status: 400 });
      }
      authUserId = invite.user.id;
      status = "pending";
    }

    const { error: memberError } = await admin.from("brand_users").insert({
      user_id: authUserId,
      brand_id: access.brandId,
      role,
    });
    if (memberError) {
      return NextResponse.json({ error: memberError.message }, { status: 400 });
    }

    const { error: invitationError } = await admin.from("brand_invitations").insert({
      brand_id: access.brandId,
      email,
      role,
      invited_by: access.ctx.userId,
      auth_user_id: authUserId,
      status,
      ...(status === "accepted" ? { accepted_at: new Date().toISOString() } : {}),
    });
    if (invitationError) {
      console.warn("Member added but invitation audit row failed:", invitationError.message);
    }

    return NextResponse.json({ ok: true, invited: status === "pending", email, role }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Could not add workspace member." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const access = await selectedBrandAndRole(typeof body.brand_id === "string" ? body.brand_id : null);
    if (access.error) return access.error;
    const userId = typeof body.user_id === "string" ? body.user_id : "";
    if (!userId || userId === access.ctx.userId) {
      return NextResponse.json({ error: "You cannot remove your own workspace access." }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data: target } = await admin
      .from("brand_users")
      .select("id, role")
      .eq("brand_id", access.brandId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!target) return NextResponse.json({ error: "Member not found." }, { status: 404 });
    if (target.role === "owner") return NextResponse.json({ error: "The workspace owner cannot be removed." }, { status: 400 });

    const { error } = await admin.from("brand_users").delete().eq("brand_id", access.brandId).eq("user_id", userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    await admin
      .from("brand_invitations")
      .update({ status: "revoked" })
      .eq("brand_id", access.brandId)
      .eq("auth_user_id", userId)
      .eq("status", "pending");
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Could not remove workspace member." }, { status: 500 });
  }
}
