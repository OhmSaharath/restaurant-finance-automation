"""Resilient, zero-error auto-discovery store resolver.

Resolves a (platform, raw_shop_name) pair to a branch_id WITHOUT ever raising a
422. Resolution strategy is store/brand-scoped and order-stable:

  Phase A (store vs branch) — a root-cause fix, not a data-cleanup migration:
  the raw shop name is first SPLIT generically into a STORE (brand) and a
  BRANCH (location) so the resolver NEVER again mashes "store + branch" into a
  single branch_name. The split is generic (no per-tenant store-name tuning):

    a. " - " separator  -> store before, branch after   (Grab convention)
    b. known-brand prefix -> remainder is the branch    (matches tenant stores)
    c. else              -> whole name = NEW store, branch "HQ"

  Then, scoped strictly to the tenant's brand set (``tenant_brand_ids``):
    1. Store resolution  -> find-or-create the brand by (normalized) name;
                            a newly created store is linked to the current user
                            via ``public.brand_users`` (requires ``user_id``).
    2. Branch resolution -> resolve/create the branch UNDER that store brand
                            (name = location only) using the existing tiers:
                            authoritative -> fuzzy -> skeleton -> substring,
                            else auto-create with branch_name = location.
    3. No-store guard    -> opaque code/ID store names are never promoted to
                            brands; they fall to branch-only matching against
                            the tenant's existing branches, else PENDING.

Returns a tuple ``(branch_id: str, status: str)`` where status is one of the
STATUS_* constants below. The function NEVER returns a nil/all-zero UUID and
NEVER raises ValueError as long as a resolvable branch exists within the
tenant's brand scope.

SCHEMA NOTES:
  * ``public.branch_platform_mappings`` is brand-scoped after migration; it
    stores ``brand_id`` and enforces UNIQUE(brand_id, platform, raw_shop_name).
  * ``public.brand_users`` (user_id, brand_id, role) is the tenant multi-store
    link. Store creation ONLY auto-links via brand_users when a ``user_id`` is
    supplied; without it a brand cannot be RLS-scoped, so a new store is NOT
    auto-created (documented limitation — see ``_resolve_store_brand``).

ISOLATION contract: every store/branch lookup and creation is restricted to
``tenant_brand_ids`` (the user's brand set from getTenantUserContext). When the
caller cannot supply ``user_id``, lookups still run against that set but NEW
store creation is skipped — the job stays scoped to the passed brand set and
falls back to branch-only matching, never creating a cross-tenant brand.
"""
from typing import Dict, Iterable, List, Optional, Tuple, Set

import difflib
import re
import logging
import hashlib
import unicodedata

from supabase import Client

from app.core.database import get_supabase_client

logger = logging.getLogger("resolver")

# Status flags returned to the caller (used to stamp details.mapping_status).
STATUS_AUTHORITATIVE = "AUTHORITATIVE"
STATUS_FUZZY_MAPPED = "FUZZY_MAPPED"
STATUS_AUTO_CREATED = "AUTO_CREATED"
STATUS_PENDING_CONFIRMATION = "PENDING_CONFIRMATION"


class ResolverDatabaseUnavailable(RuntimeError):
    """Raised when a resolver read/write cannot be trusted.

    A transient PostgREST/network failure must never be treated as an empty
    tenant scope.  Doing so makes the auto-discovery path create a second
    brand/branch for the same settlement and breaks idempotency.
    """


def _is_unique_violation(exc: Exception) -> bool:
    """Return True only for a PostgreSQL duplicate-key race."""
    code = str(getattr(exc, "code", "") or "")
    text = str(exc).lower()
    return code == "23505" or "duplicate key value" in text or "unique constraint" in text

# In-memory fast cache keyed by (brand, normalized_platform, normalized_shop).
# Value is a 3-tuple (branch_id, store_brand_id, status); store_brand_id is the
# brand the cached branch belongs to, so the write path re-keys to the same store.
_StoreKey = Tuple[Optional[str], str, str]
_STORE_CACHE: Dict[_StoreKey, Tuple[str, str, Optional[str]]] = {}

# Default branch code/name for first-time auto-discovery branches.
DEFAULT_BRANCH_CODE = "HQ"
# Thai: "Head Office (HQ)" — declared via escapes to survive every toolchain
# channel without terminal mojibake.
DEFAULT_BRANCH_NAME = "\u0e2a\u0e33\u0e19\u0e31\u0e01\u0e07\u0e32\u0e19\u0e43\u0e2b\u0e0d\u0e48 (HQ)"

# Brand auto-provision placeholder name (only used when the brand row does not
# yet exist; existing tenant names are NEVER overwritten).
AUTO_BRAND_NAME = "New Brand (Auto-Sync)"


def _canonical_text(value: Optional[str]) -> str:
    """Canonicalize Thai/Unicode text before matching or persisting mappings.

    LINE MAN exports emit Sara Am as either precomposed U+0E33 or the
    decomposed U+0E4D U+0E32 pair. NFKC alone decomposes U+0E33, so fold the
    pair back after NFKC or the same shop creates a second mapping/branch.
    """
    if value is None:
        return ""
    text = unicodedata.normalize("NFKC", str(value))
    text = text.replace("\u0e4d\u0e32", "\u0e33")
    text = re.sub(r"[\u200b-\u200d\ufeff]", "", text)
    return " ".join(text.split())


def _normalize(name: Optional[str]) -> str:
    """Lowercase, collapse whitespace, strip punctuation for loose matching."""
    if not name:
        return ""
    n = _canonical_text(name).lower()
    n = n.replace("(", " ").replace(")", " ").replace("-", " ")
    return " ".join(n.split())


# Canonical platform values allowed by the live branch_platform_mappings CHECK
# constraint (see docs/DATABASE_SCHEMA_LIVE.md). Resolver input platforms may
# arrive lowercase ("lineman", "grab") from the ingestion endpoints, so they are
# normalized here before any query/insert against that column.
_PLATFORM_CANONICAL = {
    "grab": "Grab",
    "grabfood": "Grab",
    "lineman": "LINE MAN",
    "line man": "LINE MAN",
    "line_man": "LINE MAN",
    "shopee": "Shopee Food",
    "shopeefood": "Shopee Food",
    "robinhood": "Robinhood",
    "rbh": "Robinhood",
}


def _canonical_platform(platform: Optional[str]) -> str:
    """Return the canonical platform string matching the live CHECK constraint."""
    _p = str(platform or "").strip()
    return _PLATFORM_CANONICAL.get(_p.lower(), _p)


# ---------------------------------------------------------------------------
# Cache helpers (kept for backward compatibility with prior resolver API)
# ---------------------------------------------------------------------------
def register_mapping_in_cache(platform: str, raw_shop_name: str, branch_id: str, brand_id: Optional[str] = None) -> None:
    _STORE_CACHE[(brand_id or "", _normalize(platform), _normalize(raw_shop_name))] = (
        str(branch_id), brand_id or "", STATUS_AUTHORITATIVE,
    )


def clear_store_cache() -> None:
    _STORE_CACHE.clear()


def get_cached_mappings() -> Dict[_StoreKey, Tuple[str, str, Optional[str]]]:
    return dict(_STORE_CACHE)


def warm_cache_from_db(supabase_client: Optional[Client] = None) -> int:
    client = supabase_client or get_supabase_client()
    if client is None:
        return 0
    try:
        resp = client.table("branch_platform_mappings").select("platform, raw_shop_name, branch_id").execute()
        count = 0
        for row in resp.data or []:
            bid = str(row.get("branch_id") or "")
            if not bid:
                continue
            _STORE_CACHE[("", _normalize(row.get("platform")), _normalize(row.get("raw_shop_name")))] = (
                bid,
                "",
                STATUS_AUTHORITATIVE,
            )
            count += 1
        return count
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Brand / tenant-scoped branch helpers
# ---------------------------------------------------------------------------
def _fetch_brand_branches(client: Client, brand_id: Optional[str]) -> List[dict]:
    """Fetch ACTIVE branches scoped to a brand (all active when brand_id absent).

    Kept for backward compatibility; the Phase-A path prefers the tenant-scoped
    ``_fetch_branches_in`` so lookups never span tenants.
    """
    try:
        q = client.table("branches").select("id, brand_id, branch_name, branch_code, is_active").eq("is_active", True)
        if brand_id:
            q = q.eq("brand_id", brand_id)
        return list(q.execute().data or [])
    except Exception as e:
        logger.error(f"[RESOLVER ERROR] Database error fetching branches: {e}")
        raise ResolverDatabaseUnavailable("Could not read active branches safely") from e


def _fetch_branches_in(client: Client, brand_ids: Optional[Iterable[str]]) -> List[dict]:
    """Fetch ACTIVE branches restricted strictly to the tenant's brand set.

    Multi-brand analog of ``_fetch_brand_branches`` that never spans tenants:
    the brand_id ``IN`` filter is the tenant-isolation gate. Returns [] on an
    empty scope or a DB error so the caller can fall back safely.
    """
    ids = {str(b) for b in (brand_ids or []) if b}
    if not ids:
        return []
    try:
        resp = (
            client.table("branches")
            .select("id, brand_id, branch_name, branch_code, is_active")
            .eq("is_active", True)
            .in_("brand_id", list(ids))
            .execute()
        )
        return [dict(r) for r in (resp.data or [])]
    except Exception as e:
        logger.error(f"[RESOLVER ERROR] Database error fetching tenant branches: {e}")
        raise ResolverDatabaseUnavailable("Could not read tenant branches safely") from e


def _fetch_tenant_brands(client: Client, brand_ids: Optional[Iterable[str]]) -> List[dict]:
    """Fetch the tenant's existing STORE (brand) rows restricted to brand_ids."""
    ids = {str(b) for b in (brand_ids or []) if b}
    if not ids:
        return []
    try:
        resp = client.table("brands").select("id, name").in_("id", list(ids)).execute()
        return [
            dict(r)
            for r in (resp.data or [])
            if not str(r.get("name") or "").startswith("[ARCHIVED DUPLICATE]")
        ]
    except Exception as e:
        logger.error(f"[RESOLVER ERROR] Failed to fetch tenant brands: {e}")
        raise ResolverDatabaseUnavailable("Could not read tenant brands safely") from e


def _ensure_brand_exists(client: Client, brand_id: str) -> None:
    """Idempotently ensure a brand row exists for the given brand_id.

    Prevents the branch auto-create insert from violating the FK to
    public.brands. Uses a PLAIN INSERT (not upsert) so an existing tenant brand
    is NEVER overwritten; a duplicate-key error means the brand already exists
    and is safe to proceed with.
    """
    if not brand_id:
        return
    try:
        client.table("brands").insert(
            {"id": brand_id, "name": AUTO_BRAND_NAME}
        ).execute()
    except Exception:
        # Brand already exists (duplicate key) or permission issue -> safe to
        # proceed; the branch insert is the real gate and is handled upstream.
        pass


def _insert_store_brand(
    client: Client,
    store_name: str,
    user_id: str,
    tenant_brand_ids: Optional[Set[str]] = None,
) -> Optional[str]:
    """Insert a brand row for a NEW store and link it to the tenant user.

    Returns the new brand_id, or None on failure. A brand_users membership row
    (role='owner') ties the new store to the current user so it is owned by the
    right tenant (RLS scope). Both inserts are best-effort: a brand that already
    won a concurrent race is reused; a brand_users duplicate is ignored.

    RACE-SAFE (bugfix 2026-09-18): before inserting, re-query for any existing
    brand with the SAME normalized name and reuse it. The old code inserted
    unconditionally, so concurrent syncs (push + manual + cron) each saw "no
    brand named X" and created duplicate "แมวอ้วนต้มน้ำปลา" brands — which the
    resolver then matched non-deterministically and split the same shop's sales
    across multiple branch_id's (triple-counted daily_reports).

    TENANT-SCOPED (bugfix 2026-09-18): the reuse lookup is restricted to
    ``tenant_brand_ids`` (the current user's own brand set). A brand is NEVER
    reused across tenants — two different restaurant owners may legitimately
    name their store "แมวอ้วนต้มน้ำปลา"; reusing by name GLOBALLY would attach
    tenant B's sales to tenant A's brand.
    """
    ids = {str(b) for b in (tenant_brand_ids or []) if b}

    # 1. Reuse an existing same-name brand WITHIN the tenant's brand set.
    if ids:
        try:
            existing = client.table("brands").select("id, name").in_("id", list(ids)).execute()
            for row in existing.data or []:
                if _normalize(row.get("name")) == _normalize(store_name):
                    bid = str(row.get("id") or "")
                    if bid:
                        return bid
        except Exception as e:
            logger.error(f"[RESOLVER ERROR] brand reuse lookup failed for {store_name!r}: {e}")
            raise ResolverDatabaseUnavailable("Could not verify an existing store brand") from e

    # 2. No same-name brand in scope: insert a new one.
    try:
        # ``owner_user_id`` participates in the live per-owner unique index.
        # Setting it on the INSERT (rather than relying on the follow-up
        # brand_users INSERT + trigger) closes the race where two concurrent
        # Gmail workers both create the same store before either membership
        # row has been linked.
        resp = client.table("brands").insert(
            {"name": store_name, "owner_user_id": str(user_id)}
        ).select("id").execute()
        rows = resp.data or []
        if not rows or not rows[0].get("id"):
            return None
        bid = str(rows[0]["id"])
    except Exception as e:
        if not _is_unique_violation(e):
            raise ResolverDatabaseUnavailable("Could not create store brand safely") from e
        # Duplicate key (lost a race against another worker) -> reuse the winner
        # (still restricted to the tenant scope).
        try:
            # The unique index is scoped to owner_user_id + normalized_name;
            # use both when recovering the winner of a concurrent insert.
            q = (
                client.table("brands")
                .select("id, name")
                .eq("owner_user_id", str(user_id))
                .eq("normalized_name", _normalize(store_name))
            )
            if ids:
                q = q.in_("id", list(ids))
            existing = q.limit(1).execute()
            if existing.data:
                return str(existing.data[0].get("id") or "")
        except Exception:
            # Backward-compatible recovery for an environment that has not
            # applied the owner/name migration yet.
            try:
                q = client.table("brands").select("id, name").eq("name", store_name)
                if ids:
                    q = q.in_("id", list(ids))
                existing = q.limit(1).execute()
                if existing.data:
                    return str(existing.data[0].get("id") or "")
            except Exception:
                pass
        logger.error(f"[RESOLVER ERROR] Failed to create new store brand {store_name!r}: {e}")
        return None
    try:
        client.table("brand_users").insert(
            {"user_id": str(user_id), "brand_id": bid, "role": "owner"}
        ).execute()
    except Exception as e:
        logger.warning(f"[RESOLVER WARN] Could not link user {user_id!r} to new store {bid!r}: {e}")
    return bid


def _resolve_store_brand(
    client: Client,
    store_name: str,
    tenant_brand_ids: Optional[Set[str]],
    user_id: Optional[str],
) -> Optional[str]:
    """Find-or-create the brand for ``store_name``, strictly tenant-scoped.

    Lookup is IN(tenant_brand_ids) on a normalized name match — never a
    cross-tenant query. When the store is new it is created ONLY if ``user_id``
    is supplied (so it can be linked via brand_users and RLS-scoped). Without
    ``user_id`` a brand cannot be safely owned, so this returns None and the
    caller falls back to tenant-scoped branch-only matching (documented
    limitation) instead of creating an orphan brand.
    """
    if not tenant_brand_ids:
        return None
    normalized = _normalize(store_name)
    try:
        rows = _fetch_tenant_brands(client, tenant_brand_ids)
    except Exception:
        rows = []
    for row in rows:
        if _normalize(row.get("name")) == normalized:
            return str(row["id"])
    if not user_id:
        logger.info(f"[RESOLVER] New store {store_name!r} not created: no user_id to link/RLS-scope it.")
        return None
    return _insert_store_brand(client, store_name, user_id, tenant_brand_ids)


# ---------------------------------------------------------------------------
# Generic STORE vs BRANCH split (Phase A)
# ---------------------------------------------------------------------------
# An opaque code/ID store name: a leading digit run glued to alnum (e.g. "3889624bX"),
# NOT a bare title-cased Latin word (so "Starbucks"/"Subway" are never refused).
_OPAQUE_RE = re.compile(r"^[0-9]{3,}[A-Za-z0-9]{3,}$")
# Opaque leading code glued to a Thai location, e.g. "3889624bX suiteasa"
# (Thai location after the code). Never promote the code to a brand.
_OPAQUE_WITH_THAI_RE = re.compile(r"^([A-Za-z0-9]{6,})[^A-Za-z0-9]+([\u0e00-\u0e7f])")


def _looks_opaque_code(name: Optional[str]) -> bool:
    """True when a store name looks like an opaque code/ID (never a brand).

    Matches either a bare pure-alnum token (no Thai/space) or a leading opaque
    alnum token glued to a Thai location. Conservative by design so a real Thai
    store name (which starts with Thai script, not an ASCII code) never trips it.
    """
    n = (name or "").strip()
    if not n:
        return False
    if _OPAQUE_RE.match(n):
        return True
    return bool(_OPAQUE_WITH_THAI_RE.match(n))


def _split_store_branch(clean_shop: Optional[str], existing_brands: List[dict]) -> Tuple[Optional[str], Optional[str]]:
    """Split a raw shop name into (store_name, branch_name) generically.

    Priority order:
      a. " - " separator (Grab) -> store before first " - ", branch after.
      b. Known-brand prefix/containment -> store = that brand, branch = remainder.
      c. else -> whole name = NEW store, branch = "HQ".

    Returns (None, None) when the input is empty, is an opaque code/ID, or the
    split produces an empty store/branch (guard against mashing). ``store`` is
    returned in the canonical stored spelling so the DB name stays faithful.
    """
    raw = _canonical_text(clean_shop)
    if not raw:
        return None, None
    if _looks_opaque_code(raw):
        return None, None

    # a. Grab " - " separator: store = part before the FIRST " - ".
    if " - " in raw:
        store_part, _, loc_part = raw.partition(" - ")
        store = store_part.strip()
        branch = loc_part.strip()
        if store and branch:
            if _looks_opaque_code(store):
                return None, None
            return store, branch

    # b. Conservative prefix/containment match against the tenant's existing
    #    STORE (brand) names — the normalized new name starts with a known store
    #    and has a non-empty remainder that is the branch/location.
    normalized = _normalize(raw)
    if existing_brands and normalized:
        # Prefer the longest known brand first. This makes matching stable when
        # one store name is a prefix of another (e.g. "น้ำเต้าหู้" and a
        # malformed legacy "น้ำเต้าหู้สี่แยก...") and prevents a parser retry
        # from creating a second brand for the same settlement shop.
        candidates = sorted(
            existing_brands,
            key=lambda b: len(_normalize(b.get("name"))),
            reverse=True,
        )
        for b in candidates:
            bname = _canonical_text(b.get("name"))
            bnorm = _normalize(bname)
            if not bnorm or len(bnorm) < 2:
                continue
            if normalized == bnorm:
                return bname, "HQ"
            if normalized.startswith(bnorm) and len(normalized) > len(bnorm):
                branch = raw[len(bname):].strip(" -")
                if branch:
                    return bname, branch

    # c. Whole name is a NEW store; branch defaults to HQ.
    return raw, "HQ"


# ---------------------------------------------------------------------------
# Branch matching tiers (authoritative / fuzzy / skeleton / substring)
# ---------------------------------------------------------------------------
_CLEAN_FILLER_RE = re.compile(r"(line\s*man|grab|food|\u0e2a\u0e32\u0e02\u0e32)")


def _substring_match(clean_name: str, branches: List[dict]) -> Optional[str]:
    """Substring / branch_code equality against a branch list."""
    for b in branches:
        bid = str(b.get("id") or "")
        if not bid:
            continue
        b_name = _normalize(b.get("branch_name"))
        b_code = _normalize(b.get("branch_code"))
        if (
            (b_name and (b_name in clean_name or clean_name in b_name))
            or (b_code and b_code == clean_name)
        ):
            return bid
    return None


def _match_branch_in_list(
    client: Client,
    platform: str,
    clean_name: str,
    clean_shop_raw: Optional[str],
    branches: List[dict],
) -> Tuple[Optional[str], Optional[str]]:
    """Fuzzy -> Thai-skeleton -> substring match against a branch list.

    Returns (branch_id, status) or (None, None). A confident hit persists the
    platform mapping so later ingests resolve authoritatively. Runs ONLY on the
    supplied (already tenant-scoped) branch list — never a global scan.
    """
    if not clean_name or not branches:
        return None, None

    # Fuzzy (difflib SequenceMatcher, 0.65 threshold) tolerates glitched/missing
    # Thai vowels from Grab PDFs.
    best_id = None
    best_ratio = 0.0
    clean_term = _CLEAN_FILLER_RE.sub("", clean_name).strip()
    for b in branches:
        if b.get("is_active") is False:
            continue
        bname = _normalize(b.get("branch_name") or "")
        target = _CLEAN_FILLER_RE.sub("", bname).strip()
        ratio = difflib.SequenceMatcher(None, clean_term, target).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_id = str(b.get("id") or "")
    if best_ratio >= 0.65 and best_id:
        _insert_mapping(client, best_id, platform, clean_name)
        return best_id, STATUS_FUZZY_MAPPED

    # Thai consonant skeleton (tolerates vowel decomposition).
    raw_skeleton = extract_consonant_skeleton(clean_shop_raw or "")
    if raw_skeleton:
        best_bid = None
        best_score = 0.0
        for b in branches:
            if b.get("is_active") is False:
                continue
            ts = extract_consonant_skeleton(b.get("branch_name") or "")
            if not ts:
                continue
            score = 0.95 if (raw_skeleton in ts or ts in raw_skeleton) else difflib.SequenceMatcher(None, raw_skeleton, ts).ratio()
            if score > best_score:
                best_score = score
                best_bid = str(b.get("id") or "")
        if best_score >= 0.55 and best_bid:
            _insert_mapping(client, best_bid, platform, clean_shop_raw)
            return best_bid, STATUS_FUZZY_MAPPED

    # Substring / exact branch_code.
    bid = _substring_match(clean_name, branches)
    if bid:
        _insert_mapping(client, bid, platform, clean_name)
        return bid, STATUS_FUZZY_MAPPED

    return None, None


def _match_authoritative(client: Client, platform: str, clean_name: str, branch_ids: Set[str]) -> Optional[str]:
    """Authoritative branch_platform_mappings lookup, verified in-scope.

    Returns the mapped branch_id only when it belongs to the tenant's branch id
    set. A mapping pointing outside the scope is skipped (never trusted across
    tenants) and left for cleanup elsewhere.
    """
    if not clean_name:
        return None
    try:
        resp = (
            client.table("branch_platform_mappings")
            .select("id, branch_id, raw_shop_name")
            .eq("platform", platform)
            .execute()
        )
        for row in resp.data or []:
            if _normalize(row.get("raw_shop_name")) != clean_name:
                continue
            bid = str(row.get("branch_id") or "")
            if not bid:
                continue
            if branch_ids and bid in branch_ids:
                return bid
    except Exception as e:
        logger.warning(f"[RESOLVER WARN] Mapping query failed: {e}")
        raise ResolverDatabaseUnavailable("Could not read platform mappings safely") from e
    return None


def _match_authoritative_in_scope(
    client: Client,
    platform: str,
    clean_name: str,
    branch_ids: Set[str],
    branches: Optional[List[dict]] = None,
) -> Optional[str]:
    """Resolve an existing raw shop mapping before any brand auto-creation.

    A settlement can arrive with a merchant/branch spelling that the generic
    store splitter cannot separate.  If that exact raw name was already
    mapped, creating a new brand from the whole string would split one store's
    totals across two branches. Existing mappings are the strongest source of
    truth, so use them first. When historical bad data left multiple mappings
    for the same raw name, prefer a user-created/manual branch over a
    provisional AUTO branch, then choose deterministically; this makes replays
    idempotent and prevents another duplicate from being added.
    """
    if not clean_name or not branch_ids:
        return None
    try:
        resp = (
            client.table("branch_platform_mappings")
            .select("branch_id, raw_shop_name, created_at")
            .eq("platform", platform)
            .execute()
        )
        candidates = []
        for row in resp.data or []:
            bid = str(row.get("branch_id") or "")
            if bid in branch_ids and _normalize(row.get("raw_shop_name")) == clean_name:
                candidates.append(row)
        if not candidates:
            return None
        branch_by_id = {
            str(b.get("id")): b for b in (branches or []) if b.get("id")
        }

        def rank(row: dict) -> tuple:
            branch = branch_by_id.get(str(row.get("branch_id") or ""), {})
            code = str(branch.get("branch_code") or "").upper()
            # Prefer a user-created/manual branch over a provisional AUTO-
            # branch when both mappings represent the same source shop.
            auto_rank = 1 if (code.startswith("AUTO-") or code.endswith("-AUTO")) else 0
            return (
                auto_rank,
                str(row.get("created_at") or ""),
                str(row.get("branch_id") or ""),
            )

        candidates.sort(key=rank)
        return str(candidates[0].get("branch_id") or "") or None
    except Exception as e:
        logger.warning(f"[RESOLVER WARN] In-scope mapping preflight failed: {e}")
        raise ResolverDatabaseUnavailable("Could not read in-scope platform mappings safely") from e


def _mark_mapping_persisted(cache_key: _StoreKey, branch_id: str) -> None:
    """Update the in-memory cache (DB persistence handled inline).

    Used only in legacy paths where the owning brand is not known; the cache
    entry still stores a 3-tuple with an empty store_brand_id placeholder.
    """
    _STORE_CACHE[cache_key] = (str(branch_id), "", STATUS_AUTHORITATIVE)


def _insert_mapping(client: Client, branch_id: str, platform: str, raw_shop_name: str) -> Optional[str]:
    """Atomically persist a brand-scoped mapping and return its winning branch.

    The old select-then-insert sequence was racy: concurrent Gmail/manual
    syncs could all create a different AUTO branch before one mapping won.
    """
    platform = _canonical_platform(platform)
    # Store one canonical spelling so composed/decomposed Thai variants hit
    # the same (brand, platform, raw_shop_name) unique key.
    raw = _canonical_text(raw_shop_name)
    if not raw:
        return None
    try:
        brand_res = (
            client.table("branches")
            .select("brand_id")
            .eq("id", str(branch_id))
            .limit(1)
            .execute()
        )
        brand_id = str((brand_res.data or [{}])[0].get("brand_id") or "")
        if not brand_id:
            return None
        client.table("branch_platform_mappings").upsert(
            {
                "brand_id": brand_id,
                "branch_id": str(branch_id),
                "platform": platform,
                "raw_shop_name": raw,
            },
            on_conflict="brand_id,platform,raw_shop_name",
            ignore_duplicates=True,
        ).execute()
        winner = (
            client.table("branch_platform_mappings")
            .select("branch_id")
            .eq("brand_id", brand_id)
            .eq("platform", platform)
            .eq("raw_shop_name", raw)
            .limit(1)
            .execute()
        )
        return str((winner.data or [{}])[0].get("branch_id") or "") or None
    except Exception as e:
        # A mapping conflict is expected when another worker won the race. Read
        # the winner back; never return the newly-created branch when the
        # mapping write was not confirmed, or the same settlement can land on
        # two branch_ids.
        try:
            winner = (
                client.table("branch_platform_mappings")
                .select("branch_id")
                .eq("platform", platform)
                .eq("raw_shop_name", raw)
                .execute()
            )
            # Do not resurrect a mapping that points at an archived/inactive
            # branch.  A stale mapping must be repaired explicitly; silently
            # returning it would make the next import disappear from active
            # analytics or split it into another branch.
            for candidate in winner.data or []:
                winner_id = str(candidate.get("branch_id") or "")
                if not winner_id:
                    continue
                active = (
                    client.table("branches")
                    .select("id")
                    .eq("id", winner_id)
                    .eq("is_active", True)
                    .limit(1)
                    .execute()
                )
                if active.data:
                    return winner_id
        except Exception as read_exc:
            raise ResolverDatabaseUnavailable("Could not verify platform mapping after write failure") from read_exc
        logger.warning(f"[RESOLVER WARN] Mapping write failed for {platform}/{raw!r}: {e}")
        raise ResolverDatabaseUnavailable("Platform mapping was not persisted") from e


def _stable_branch_code(branch_name: Optional[str]) -> str:
    """Return a deterministic code so concurrent discovery hits one key."""
    normalized = _normalize(branch_name) or "hq"
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:6].upper()
    return f"AUTO-{digest}"


def _deactivate_loser(client: Client, branch_id: str, winner_id: Optional[str]) -> None:
    """Keep a raced branch recoverable but out of active tenant queries."""
    if not winner_id or str(branch_id) == str(winner_id):
        return
    try:
        client.table("branches").update({"is_active": False}).eq("id", str(branch_id)).execute()
    except Exception as e:
        logger.warning(f"[RESOLVER WARN] Could not deactivate raced branch {branch_id}: {e}")


def _find_active_branch(client: Client, brand_id: str, *, branch_code: Optional[str] = None,
                        branch_name: Optional[str] = None) -> Optional[str]:
    """Read back a branch that won a concurrent unique-key insert."""
    try:
        query = (
            client.table("branches")
            .select("id")
            .eq("brand_id", str(brand_id))
            .eq("is_active", True)
        )
        if branch_code:
            query = query.eq("branch_code", branch_code)
        elif branch_name:
            query = query.eq("branch_name", branch_name)
        row = (query.limit(1).execute().data or [])
        return str(row[0].get("id") or "") or None
    except Exception as e:
        raise ResolverDatabaseUnavailable("Could not verify a concurrent branch insert") from e


def extract_consonant_skeleton(text: str) -> str:
    """Reduce Thai text to a consonant skeleton for glitch-tolerant matching.

    Strips Thai vowels/diacritics/tone marks (U+0E30–U+0E4E) then keeps only
    Thai consonants, Latin letters, and digits. Two shop strings whose vowels
    decomposed differently in the PDF will share a skeleton.
    """
    if not text:
        return ""
    # Strip Thai vowels, diacritics, and tone marks (U+0E30 - U+0E4E).
    no_vowels = re.sub(r"[\u0E30-\u0E4E]", "", text)
    # Strip everything except Thai consonants, Latin characters, and digits.
    return re.sub(r"[^\u0E01-\u0E2Ea-zA-Z0-9]", "", no_vowels).lower()


def _tenant_scope(
    client: Client,
    brand_id: Optional[str],
    tenant_brand_ids: Optional[Iterable[str]],
) -> Tuple[Set[str], Optional[str]]:
    """Derive the tenant's brand scope + primary (legacy) brand.

    When ``tenant_brand_ids`` is supplied it is the authoritative tenant set
    (from getTenantUserContext). Otherwise fall back to the single passed
    ``brand_id`` (legacy single-brand scoping). When neither is present, fail
    CLOSED (empty scope, primary None) — never widen to an arbitrary brand.
    Returns (scope_set, primary_brand_id).
    """
    scope = {str(b) for b in (tenant_brand_ids or []) if b}
    primary = str(brand_id) if brand_id else None
    if primary:
        # Only honor a caller-supplied primary brand if it is already in the
        # tenant set; otherwise fail closed (do not widen scope to an
        # arbitrary/foreign brand).
        if scope and primary not in scope:
            return set(), None
        scope.add(primary)
    if not scope:
        # Fail closed: no tenant context at all. Never fall back to an
        # arbitrary/global brand (cross-tenant leak). Empty scope lets the
        # caller raise per the documented "no tenant scope left" contract.
        return scope, None
    primary = primary or next(iter(scope))
    return scope, primary


def _resolve_branch_only(
    client: Client,
    platform: str,
    clean_name: str,
    clean_shop_raw: Optional[str],
    tenant_branches: List[dict],
    cache_key: _StoreKey,
    primary_brand: Optional[str],
) -> Tuple[str, Optional[str], str]:
    """No-store path: branch-only matching against the tenant's branches.

    Used for opaque-code store names (never promoted to a brand) and when a NEW
    store cannot be safely created (no user_id to RLS-scope it). NEVER creates a
    mashed store+branch name. Falls back to the first active tenant branch as
    PENDING_CONFIRMATION; only when the tenant has NO branches at all does it
    auto-create an HQ branch under the primary brand scope (preserving the
    never-raise contract), else it raises exactly as the original contract did.

    Returns ``(branch_id, store_brand_id, status)``. The branch produced here
    belongs to ``primary_brand`` (the tenant's primary/legacy store brand), so
    that is returned as store_brand_id — always a real, in-scope brand whenever
    a branch is produced (never None on a successful return).
    """
    branch_ids = {str(b.get("id")) for b in tenant_branches if b.get("id")}

    # Authoritative mapping tier (verified in tenant scope).
    if clean_name:
        mapped = _match_authoritative(client, platform, clean_name, branch_ids)
        if mapped:
            _STORE_CACHE[cache_key] = (mapped, primary_brand or "", STATUS_AUTHORITATIVE)
            return mapped, primary_brand, STATUS_AUTHORITATIVE

    # Fuzzy / skeleton / substring against the tenant's branches.
    bid, status = _match_branch_in_list(client, platform, clean_name, clean_shop_raw, tenant_branches)
    if bid:
        _STORE_CACHE[cache_key] = (bid, primary_brand or "", status or STATUS_FUZZY_MAPPED)
        return bid, primary_brand, status or STATUS_FUZZY_MAPPED

    # Absolute last resort: first active tenant branch as PENDING_CONFIRMATION.
    for b in tenant_branches:
        if b.get("is_active") is False:
            continue
        fb = str(b.get("id") or "")
        if not fb:
            continue
        _STORE_CACHE[cache_key] = (fb, primary_brand or "", STATUS_PENDING_CONFIRMATION)
        logger.warning(
            f"[RESOLVER FALLBACK] Unmatched shop {clean_name!r} assigned to first active branch {fb} (PENDING_CONFIRMATION)"
        )
        return fb, primary_brand, STATUS_PENDING_CONFIRMATION

    # Tenant has zero branches: auto-create an HQ branch under the primary scoped
    # brand (still tenant-isolated) so the pipeline never dead-ends.
    if primary_brand:
        try:
            _ensure_brand_exists(client, primary_brand)
            insert_res = client.table("branches").insert(
                {
                    "branch_name": clean_name or DEFAULT_BRANCH_NAME,
                    "branch_code": DEFAULT_BRANCH_CODE,
                    "brand_id": primary_brand,
                    "is_active": True,
                }
            ).execute()
            if insert_res.data and insert_res.data[0].get("id"):
                new_id = str(insert_res.data[0]["id"])
                _insert_mapping(client, new_id, platform, clean_name)
                _STORE_CACHE[cache_key] = (new_id, primary_brand, STATUS_AUTO_CREATED)
                return new_id, primary_brand, STATUS_AUTO_CREATED
        except Exception as e:
            logger.error(f"[RESOLVER ERROR] Failed to auto-provision fallback branch: {e}")
            # A transient read/write failure is not evidence that the tenant
            # has no branch.  Stop the ingestion rather than creating a ghost
            # branch on a partial view of the database.
            if not _is_unique_violation(e):
                raise ResolverDatabaseUnavailable("Could not provision fallback branch safely") from e

    raise ValueError(f"Unable to resolve or create a valid branch in tenant scope (platform={platform!r}, raw_shop_name={clean_shop_raw!r})")


def resolve_branch_id(
    platform: str,
    raw_shop_name: Optional[str],
    brand_id: Optional[str],
    supabase_client=None,
    db=None,
    tenant_brand_ids: Optional[List[str]] = None,
    user_id: Optional[str] = None,
    **kwargs,
) -> Tuple[str, Optional[str], str]:
    """Resolve a (platform, raw_shop_name) to a branch_id + store brand + status.

    Phase A: first splits the raw shop name into a STORE and a BRANCH generically
    (see ``_split_store_branch``), then resolves the branch UNDER the store brand,
    all strictly scoped to the tenant's brand set. Accepts either
    ``supabase_client`` or ``db`` (both are the Supabase client from the FastAPI
    dependency).

    Optional tenant context:
      ``tenant_brand_ids`` — the user's brand set (from getTenantUserContext);
                             store/branch lookup + creation is restricted to it.
      ``user_id``          — the auth user; a NEWLY created store is linked to
                             the tenant via public.brand_users (role=owner).

    Returns ``(branch_id: str, store_brand_id: str|None, status: str)``, where
    ``store_brand_id`` is the STORE brand that owns the resolved branch. This is
    the brand the caller MUST re-key matching + writes to, so
    daily_item_sales.brand_id and branch_id always belong to the SAME store. It
    is None ONLY when no branch could be produced; whenever a branch is returned
    store_brand_id is a real, in-scope brand. Guarantees:
      - NEVER returns a nil/all-zero UUID;
      - splits store vs branch and stores branch_name = LOCATION only (no mash);
      - creates a new store brand ONLY when ``user_id`` is supplied (so it can be
        RLS-scoped/linked); otherwise falls back to tenant-scoped branch-only
        matching (documented isolation limitation, never a cross-tenant create);
      - never promotes an opaque code/ID to a brand (garbage guard);
      - creates the branch under the resolved store's brand;
      - unconditionally falls back to the first active tenant branch (PENDING)
        when there is no confident match;
      - raises ValueError ONLY when no client is supplied or there is genuinely
        no resolvable tenant scope left.
    """
    client = supabase_client or db
    if not client:
        raise ValueError("Database client is required")

    # Normalize shop name: treat literal "None"/"null"/"undefined" and generic
    # "unknown..." variants as None so they map to a tenant branch instead of
    # auto-provisioning ghost stores.
    clean_shop_raw = raw_shop_name
    if raw_shop_name is not None and str(raw_shop_name).strip().lower() in (
        "", "none", "null", "undefined", "unknown grab shop", "unknown shop"
    ):
        clean_shop_raw = None
    clean_shop = _canonical_text(clean_shop_raw) if clean_shop_raw else None
    clean_name = _normalize(clean_shop) or None

    # Canonical platform (e.g. "lineman" -> "LINE MAN") for CHECK-constrained cols.
    platform = _canonical_platform(platform)

    # --- Resolve the tenant's brand scope (isolation boundary) ---
    scope, primary_brand = _tenant_scope(client, brand_id, tenant_brand_ids)
    legacy_key = (primary_brand or "", _normalize(platform), _normalize(clean_name))

    # Tenant's existing STORE (brand) names + all its ACTIVE branches.
    tenant_brands: List[dict] = _fetch_tenant_brands(client, scope)
    tenant_branches: List[dict] = _fetch_branches_in(client, scope)

    # Mapping-first guardrail: a known raw shop name must never be promoted to
    # a new brand merely because its current spelling is hard to split.  This
    # is especially important for replayed Gmail messages and concurrent
    # manual/push syncs, where a wrong auto-created branch would double-count
    # the same settlement.
    if clean_name:
        mapped = _match_authoritative_in_scope(
            client,
            platform,
            clean_name,
            {str(b.get("id")) for b in tenant_branches if b.get("id")},
            tenant_branches,
        )
        if mapped:
            mapped_brand = next(
                (str(b.get("brand_id")) for b in tenant_branches if str(b.get("id")) == mapped),
                primary_brand,
            )
            cache_value = (mapped, mapped_brand or "", STATUS_AUTHORITATIVE)
            _STORE_CACHE[legacy_key] = cache_value
            if mapped_brand:
                _STORE_CACHE[(mapped_brand, _normalize(platform), _normalize(clean_name))] = cache_value
            return mapped, mapped_brand, STATUS_AUTHORITATIVE

    # --- Phase A: split the raw shop name into STORE vs BRANCH ---
    store_name, branch_loc = _split_store_branch(clean_shop, tenant_brands)

    # Garbage / empty store: never create a brand — branch-only matching.
    if store_name is None or branch_loc is None:
        return _resolve_branch_only(
            client, platform, clean_name, clean_shop_raw,
            tenant_branches, legacy_key, primary_brand,
        )

    # The Gmail integration's brand_id is the primary tenant scope, while a
    # consolidated settlement may legitimately contain rows for several
    # brands owned by the same user. Resolve an exact known store name within
    # that tenant set, but never search outside it.
    store_brand_id = _resolve_store_brand(client, store_name, scope, user_id)

    # Cannot safely create the store (no user_id to RLS-scope it): do NOT mash.
    # Fall back to tenant-scoped branch-only matching (still never creates the
    # mashed name).
    if store_brand_id is None:
        logger.info(
            f"[RESOLVER] No brand for store {store_name!r} and cannot create one safely; "
            "branch-only matching instead of mashing store+branch."
        )
        return _resolve_branch_only(
            client, platform, clean_name, clean_shop_raw,
            tenant_branches, legacy_key, primary_brand,
        )

    # Branches UNDER this specific store brand (tenant-owned).
    store_branches = [b for b in tenant_branches if str(b.get("brand_id")) == store_brand_id]
    store_branch_ids = {str(b.get("id")) for b in store_branches if b.get("id")}
    cache_key = (store_brand_id, _normalize(platform), _normalize(clean_name))

    # --- 1. Authoritative look-up (verified to belong to THIS store) ---
    if clean_name:
        mapped = _match_authoritative(client, platform, clean_name, store_branch_ids)
        if mapped:
            _STORE_CACHE[cache_key] = (mapped, store_brand_id, STATUS_AUTHORITATIVE)
            _STORE_CACHE[legacy_key] = (mapped, store_brand_id, STATUS_AUTHORITATIVE)
            return mapped, store_brand_id, STATUS_AUTHORITATIVE

    # --- 2. Fuzzy / skeleton / substring against THIS store's branches ---
    if store_branches:
        bid, status = _match_branch_in_list(client, platform, clean_name, clean_shop_raw, store_branches)
        if bid:
            _STORE_CACHE[cache_key] = (bid, store_brand_id, status or STATUS_FUZZY_MAPPED)
            _STORE_CACHE[legacy_key] = (bid, store_brand_id, status or STATUS_FUZZY_MAPPED)
            return bid, store_brand_id, status or STATUS_FUZZY_MAPPED
    else:
        # Any mapping for this (platform, name) that points to a different store
        # is NOT this store's branch — skip authoritative here too. Handled above.
        pass

    # --- 3. First-time branch under the store (store has 0 branches) ---
    if not store_branches:
        try:
            _ensure_brand_exists(client, store_brand_id)
            default_name = (
                (branch_loc.strip() if branch_loc and branch_loc.strip() != "HQ" else None)
                or clean_name
                or DEFAULT_BRANCH_NAME
            )
            insert_res = client.table("branches").insert(
                {
                    "branch_name": default_name,
                    "branch_code": DEFAULT_BRANCH_CODE,
                    "brand_id": store_brand_id,
                    "is_active": True,
                }
            ).execute()
            if insert_res.data and insert_res.data[0].get("id"):
                new_id = str(insert_res.data[0]["id"])
                winner_id = _insert_mapping(client, new_id, platform, clean_name)
                _deactivate_loser(client, new_id, winner_id)
                if winner_id and winner_id != new_id:
                    _STORE_CACHE[cache_key] = (winner_id, store_brand_id, STATUS_AUTHORITATIVE)
                    _STORE_CACHE[legacy_key] = (winner_id, store_brand_id, STATUS_AUTHORITATIVE)
                    return winner_id, store_brand_id, STATUS_AUTHORITATIVE
                _STORE_CACHE[cache_key] = (new_id, store_brand_id, STATUS_AUTO_CREATED)
                _STORE_CACHE[legacy_key] = (new_id, store_brand_id, STATUS_AUTO_CREATED)
                logger.info(f"[RESOLVER] Auto-created first branch {new_id} ({default_name}) for store {store_name!r}")
                return new_id, store_brand_id, STATUS_AUTO_CREATED
        except Exception as e:
            logger.error(f"[RESOLVER ERROR] Failed to auto-provision initial branch for store {store_name!r}: {e}")
            winner = _find_active_branch(client, store_brand_id, branch_code=DEFAULT_BRANCH_CODE)
            if winner:
                mapping_winner = _insert_mapping(client, winner, platform, clean_name)
                resolved = mapping_winner or winner
                _STORE_CACHE[cache_key] = (resolved, store_brand_id, STATUS_AUTHORITATIVE)
                _STORE_CACHE[legacy_key] = (resolved, store_brand_id, STATUS_AUTHORITATIVE)
                return resolved, store_brand_id, STATUS_AUTHORITATIVE
            raise ResolverDatabaseUnavailable("Could not provision initial branch safely") from e

    # --- 4. Auto-provision a new distinct branch under the store (location only) ---
    if branch_loc:
        stable_code = _stable_branch_code(branch_loc)
        try:
            _ensure_brand_exists(client, store_brand_id)
            existing = _find_active_branch(client, store_brand_id, branch_name=branch_loc)
            if existing:
                mapping_winner = _insert_mapping(client, existing, platform, clean_name)
                resolved = mapping_winner or existing
                _STORE_CACHE[cache_key] = (resolved, store_brand_id, STATUS_AUTHORITATIVE)
                _STORE_CACHE[legacy_key] = (resolved, store_brand_id, STATUS_AUTHORITATIVE)
                return resolved, store_brand_id, STATUS_AUTHORITATIVE
            branch_payload = {
                "branch_name": branch_loc,
                "branch_code": stable_code,
                "brand_id": store_brand_id,
                "is_active": True,
            }
            insert_res = client.table("branches").insert(branch_payload).execute()
            if insert_res.data and insert_res.data[0].get("id"):
                new_id = str(insert_res.data[0]["id"])
                winner_id = _insert_mapping(client, new_id, platform, clean_name)
                _deactivate_loser(client, new_id, winner_id)
                if winner_id and winner_id != new_id:
                    _STORE_CACHE[cache_key] = (winner_id, store_brand_id, STATUS_AUTHORITATIVE)
                    _STORE_CACHE[legacy_key] = (winner_id, store_brand_id, STATUS_AUTHORITATIVE)
                    return winner_id, store_brand_id, STATUS_AUTHORITATIVE
                _STORE_CACHE[cache_key] = (new_id, store_brand_id, STATUS_AUTO_CREATED)
                _STORE_CACHE[legacy_key] = (new_id, store_brand_id, STATUS_AUTO_CREATED)
                logger.info(f"[RESOLVER] Auto-created new branch {new_id} ({branch_loc!r}) for store {store_name!r}")
                return new_id, store_brand_id, STATUS_AUTO_CREATED
        except Exception as e:
            logger.error(f"[RESOLVER ERROR] Failed to auto-provision distinct branch for store {store_name!r}: {e}")
            winner = _find_active_branch(client, store_brand_id, branch_code=stable_code)
            if winner:
                mapping_winner = _insert_mapping(client, winner, platform, clean_name)
                resolved = mapping_winner or winner
                _STORE_CACHE[cache_key] = (resolved, store_brand_id, STATUS_AUTHORITATIVE)
                _STORE_CACHE[legacy_key] = (resolved, store_brand_id, STATUS_AUTHORITATIVE)
                return resolved, store_brand_id, STATUS_AUTHORITATIVE
            raise ResolverDatabaseUnavailable("Could not provision branch safely") from e

    # --- 5. Absolute last resort (scoped to this store's branches) ---
    for b in store_branches:
        if b.get("is_active") is False:
            continue
        bid = str(b.get("id") or "")
        if not bid:
            continue
        _STORE_CACHE[cache_key] = (bid, store_brand_id, STATUS_PENDING_CONFIRMATION)
        return bid, store_brand_id, STATUS_PENDING_CONFIRMATION

    # Final safety: never raise if we still have a tenant branch to fall back on.
    return _resolve_branch_only(
        client, platform, clean_name, clean_shop_raw,
        tenant_branches, legacy_key, primary_brand,
    )
