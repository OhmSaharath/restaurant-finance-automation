"""Menu-item name matching engine (Phase 1).

Two public functions:

  normalize_item_name(name) -> str
    NFC-normalize, lowercase, collapse whitespace, remove a trailing source
    UUID, and strip a conservative
    blacklist of marketing/promo tokens (bracketed tags, discount markers,
    LINE MAN exclusivity, deal call-outs). Digits and "x2"/"xN" multipliers are
    deliberately preserved — the identity is the full normalized name; merging
    different items is a USER-driven decision via menu_item_platform_mappings.

  match_item_name(raw_name, menu_items, brand_id, platform, db)
      -> (menu_item_id: str | None, status: str)
    Tiered, conservative, always brand-scoped. Tiers 1–3 are auto-confident;
    tier 4 (fuzzy ratio) matches only above a high threshold. On a confident
    match the (brand_id, platform, raw_item_name) -> menu_item mapping is
    persisted so future uploads skip fuzzy matching. Returns status one of
    EXACT / CONTAINS / SKELETON / FUZZY / UNMATCHED.

Thai/Bengali blacklist tokens are pure-ASCII \\uXXXX escapes (the edit channel
mojibakes raw script). Ground truth verified from the real samples.
"""
import difflib
import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

from app.ingestion.resolver import extract_consonant_skeleton

# ---------------------------------------------------------------------------
# Statuses
# ---------------------------------------------------------------------------
STATUS_MAPPED = "MAPPED"          # resolved via a persisted raw-name mapping (tier 0)
STATUS_EXACT = "EXACT"
STATUS_CONTAINS = "CONTAINS"
STATUS_SKELETON = "SKELETON"
STATUS_FUZZY = "FUZZY"
STATUS_UNMATCHED = "UNMATCHED"

# ---------------------------------------------------------------------------
# Marketing / promo tokens to strip (Thai, U+0E00–U+0E7F) — verified from the
# real sample files. These describe the PROMO, not the item identity.
#   discount        = \u0e25\u0e14 30%            (Thai "discount" + a percentage)
#   LINE-MAN-only   = \u0e40\u0e09\u0e1e\u0e32\u0e30\u0e17\u0e35\u0e48 LINE MAN
#   hot-deal        = \u0e14\u0e35\u0e25\u0e40\u0e14\u0e37\u0e2d\u0e14
#   great-value     = \u0e2a\u0e38\u0e14\u0e04\u0e38\u0e49\u0e21
_K_DISCOUNT = "\u0e25\u0e14"                                   # Thai: discount
_K_LINEMAN_ONLY = "\u0e40\u0e09\u0e1e\u0e32\u0e30\u0e17\u0e35\u0e48"  # Thai: only-on (LINE MAN)
_K_DEAL = "\u0e14\u0e35\u0e25\u0e40\u0e14\u0e37\u0e2d\u0e14"          # Thai: hot deal
_K_VALUE = "\u0e2a\u0e38\u0e14\u0e04\u0e38\u0e49\u0e21"              # Thai: great value

# Remove the SQUARE-BRACKET CHARACTERS but KEEP the text inside. The bracket
# content is a CATEGORY / PRODUCT identifier ("กับข้าว" side-dish, "เซ็ตคู่หู"
# duo-set, "เซ็ตเพื่อนซี้" buddy-set) that distinguishes DIFFERENT products with
# DIFFERENT costs — stripping it caused false merges and unfriendly names. Only
# the truly-promotional KEYWORD patterns below (สุดคุ้ม / ดีลเดือด / ลด X% /
# เฉพาะที่ LINE MAN / "!") are removed.
_MARKETING_PATTERNS = [
    re.compile(r"[\[\]]"),                                       # drop "[" and "]" only
    re.compile(re.escape(_K_LINEMAN_ONLY) + r"\s*LINE\s*MAN", re.IGNORECASE),
    re.compile(re.escape(_K_DISCOUNT) + r"\s*\d*\s*%?"),
    re.compile(re.escape(_K_DEAL)),
    re.compile(r"!+"),
    re.compile(r"\u0e2f\u0e25\u0e2f"),  # "" trailing et-cetera (Thai ellipsis)
]

# Parenthetical specifiers "(...)" - e.g. a cut/portion qualifier - plus any
# preceding whitespace. Removed with an EMPTY replacement (unlike the marketing
# patterns which collapse to a space) so "X (qualifier)+Y" and "X+Y" normalize
# identically. This is what splits a dish with a portion qualifier from the
# bare dish. Thai glyphs are omitted by design to keep this pure-ASCII through
# every edit channel (see multiscript skill). Nested parens are not expected.
_PAREN_GROUP = re.compile(r"\s*\([^()]*\)")

# Loyverse exports append the source item's UUID to the display name (for
# example ``ข้าวสวย — 09e87d3d-aaab-...``).  That UUID is an import identifier,
# not part of the dish identity.  Keep the raw source name in the sales row and
# mapping, but remove only this *trailing UUID* when resolving the menu master.
# Restricting the pattern to a complete UUID avoids collapsing legitimate menu
# names that happen to contain a dash and digits.
_SOURCE_UUID_SUFFIX = re.compile(
    r"\s+[—-]\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$",
    re.IGNORECASE,
)

_FUZZY_THRESHOLD = 0.75


def normalize_item_name(name: Optional[str]) -> str:
    """Return a canonical, marketing-stripped, parenthetical-stripped item name."""
    if not name:
        return ""
    s = unicodedata.normalize("NFC", str(name))
    # Thai Sara Am decomposition fix (same as grab_parser.sanitize_thai_text):
    # NFC may leave a decomposed Sara Am as U+0E4D + U+0E32; collapse to the
    # precomposed U+0E33 so decomposed and precomposed spellings become
    # identical and substring/contains matching stops splitting the same dish.
    s = re.sub(r"\u0E4D\u0E32", "\u0E33", s)
    s = s.lower()
    # Strip technical source IDs before promo/name matching.  This is
    # deliberately done before parenthetical cleanup so both
    # ``ชื่อ (หน้าร้าน) — <uuid>`` and ``ชื่อ — <uuid>`` resolve identically.
    s = _SOURCE_UUID_SUFFIX.sub("", s)
    # Parenthetical specifiers "(...)" removed entirely (empty replacement) so
    # "X (qualifier)+Y" and "X+Y" become identical.
    s = _PAREN_GROUP.sub("", s)
    for pat in _MARKETING_PATTERNS:
        s = pat.sub(" ", s)
    # Collapse remaining whitespace and tidy edge spaces.
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _item_name(item: Any) -> str:
    """Pull the name from a menu_items row (dict or object)."""
    if isinstance(item, dict):
        return str(item.get("name") or "")
    return str(getattr(item, "name", "") or "")


def _item_id(item: Any) -> Optional[str]:
    if isinstance(item, dict):
        v = item.get("id")
    else:
        v = getattr(item, "id", None)
    return str(v) if v is not None else None


def _item_active(item: Any) -> bool:
    if isinstance(item, dict):
        v = item.get("is_active", True)
    else:
        v = getattr(item, "is_active", True)
    if v is None:
        return True
    return bool(v)


def _persist_mapping(db: Any, brand_id: str, menu_item_id: str, platform: str, raw_item_name: str) -> None:
    """Persist a confident raw-name -> menu_item mapping (brand-scoped).

    Best-effort: a duplicate (UNIQUE brand_id+platform+raw_item_name) or a
    permission error is swallowed — the mapping is a cache, not the source of
    truth. Never lets a mapping write fail the ingestion.
    """
    if db is None or not brand_id or not menu_item_id or not raw_item_name:
        return
    try:
        db.table("menu_item_platform_mappings").upsert(
            {
                "brand_id": brand_id,
                "menu_item_id": menu_item_id,
                "platform": platform,
                "raw_item_name": str(raw_item_name).strip(),
            },
            on_conflict="brand_id,platform,raw_item_name",
        ).execute()
    except Exception:  # noqa: BLE001 - mapping is a cache
        pass


def match_item_name(
    raw_name: str,
    menu_items: List[Any],
    brand_id: str,
    platform: str,
    db: Any,
) -> Tuple[Optional[str], str]:
    """Match a raw item name to a brand's menu_items (tiered, conservative).

    Returns (menu_item_id | None, status). Tiers:
      1. EXACT       — normalized names equal
      2. CONTAINS    — one normalized name contains the other
      3. SKELETON    — Thai consonant skeletons equal (robust to Grab PDF
                       vowel decomposition / spacing glitches)
      4. FUZZY       — best difflib ratio across ACTIVE items, >= 0.75

    Tiers 1–3 always auto-match; tier 4 only above threshold. On any confident
    match the mapping is persisted (brand-scoped). Otherwise returns None so
    the caller creates a fresh menu_item for manual cost entry.
    """
    if not menu_items:
        return None, STATUS_UNMATCHED

    # Tier 0: persisted raw-name mapping (the "learning" path). A prior merge
    # or confident match stored an exact (brand_id, platform, raw_item_name) ->
    # menu_item row; resolve instantly, skipping fuzzy scoring. Strictly
    # brand-scoped so one tenant's mapping can never resolve to another's item.
    if db is not None and brand_id and platform and raw_name:
        try:
            map_resp = (
                db.table("menu_item_platform_mappings")
                .select("menu_item_id")
                .eq("brand_id", brand_id)
                .eq("platform", platform)
                .eq("raw_item_name", str(raw_name).strip())
                .limit(1)
                .execute()
            )
            if map_resp.data and map_resp.data[0].get("menu_item_id"):
                return str(map_resp.data[0]["menu_item_id"]), STATUS_MAPPED
        except Exception:  # noqa: BLE001 - a mapping read failure falls through to tiers
            pass

    target = normalize_item_name(raw_name)
    if not target:
        return None, STATUS_UNMATCHED
    target_skeleton = extract_consonant_skeleton(target) if any(
        ord(c) >= 0x0E00 for c in target
    ) else ""

    # Always tenant-scoped: keep only rows belonging to this brand.
    def _row_brand(item: Any) -> str:
        if isinstance(item, dict):
            return str(item.get("brand_id") or "")
        return str(getattr(item, "brand_id", "") or "")

    # Strict isolation: only fall back to the full list when the caller passed
    # rows with NO brand_id at all (i.e. the query was already brand-scoped).
    # A row carrying a DIFFERENT brand_id must NEVER be matched — that would
    # leak another tenant's menu.
    brand_counts = {_row_brand(it) for it in menu_items}
    if brand_counts == {""}:
        scoped_items = menu_items
    else:
        scoped_items = [it for it in menu_items if _row_brand(it) == str(brand_id)]
    if not scoped_items:
        return None, STATUS_UNMATCHED

    # Tier 1: exact
    for it in scoped_items:
        if normalize_item_name(_item_name(it)) == target:
            _persist_mapping(db, brand_id, _item_id(it), platform, raw_name)
            return _item_id(it), STATUS_EXACT

    # Tier 2: one contains the other (confident for same-dish wording drift)
    for it in scoped_items:
        cand = normalize_item_name(_item_name(it))
        if cand and (target in cand or cand in target):
            _persist_mapping(db, brand_id, _item_id(it), platform, raw_name)
            return _item_id(it), STATUS_CONTAINS

    # Tier 3: Thai consonant-skeleton equality (vowel decomposition tolerant)
    if target_skeleton:
        candidates = [(it, extract_consonant_skeleton(normalize_item_name(_item_name(it)))) for it in scoped_items]
        for it, sk in candidates:
            if sk and sk == target_skeleton:
                _persist_mapping(db, brand_id, _item_id(it), platform, raw_name)
                return _item_id(it), STATUS_SKELETON

    # Tier 4: fuzzy against ACTIVE items only, high threshold
    active = [it for it in scoped_items if _item_active(it)]
    best_id, best_ratio = None, 0.0
    for it in active:
        cand = normalize_item_name(_item_name(it))
        ratio = difflib.SequenceMatcher(None, target, cand).ratio()
        if ratio > best_ratio:
            best_id, best_ratio = _item_id(it), ratio
    if best_id and best_ratio >= _FUZZY_THRESHOLD:
        _persist_mapping(db, brand_id, best_id, platform, raw_name)
        return best_id, STATUS_FUZZY

    return None, STATUS_UNMATCHED
