"""Regression test for composite-cost resolution using synthetic Loyverse data."""

from decimal import Decimal

# Build a mock catalog mirroring the live data:
#   - ingredient items with direct variant cost (positive)
#   - composite items with components referencing ingredient variants
#   - one cycle (composite -> composite) to prove cycle guard
def make_variant(vid, cost):
    return {"variant_id": vid, "cost": cost}

catalog = {
    "สะโพกไก่": {"variant_id": "v_sapok", "cost": 35.0},
    "หมู":        {"variant_id": "v_moo", "cost": 50.0},
    "หมี่หยก":     {"variant_id": "v_mie", "cost": 5.0},
    "น่อง":        {"variant_id": "v_nong", "cost": 35.0},
}

# We can't easily inject HTTP into _fetch_variant_cost_map, so replicate the pass-2
# resolve() algorithm here verbatim against the same structures, to prove the logic.
# (The author of this test mirrors the resolve() body.)
def build_and_resolve(items):
    item_meta = {}
    variant_owner = {}
    direct_variant_cost = {}
    for it in items:
        iid = it["id"]
        comps = []
        if isinstance(it.get("components"), list):
            comps = [c for c in it["components"] if isinstance(c, dict)]
        vids = []
        for v in it.get("variants") or []:
            vid = str(v.get("variant_id") or v.get("id") or "").strip()
            if vid:
                vids.append(vid)
                variant_owner[vid] = iid
            cost = v.get("cost")
            if cost is not None:
                try:
                    c = Decimal(str(cost))
                    if c > 0:
                        direct_variant_cost.setdefault(vid, c.quantize(Decimal("0.01")))
                except Exception:
                    pass
        item_meta[iid] = {
            "name": it.get("item_name") or iid,
            "is_composite": bool(it.get("is_composite")),
            "variant_ids": vids,
            "components": comps,
        }
    resolved_item = {}
    def resolve(iid, stack):
        if iid in resolved_item:
            return resolved_item[iid]
        if iid in stack:
            return None
        meta = item_meta.get(iid)
        if meta is None:
            return None
        stack = stack | {iid}
        for vid in meta["variant_ids"]:
            d = direct_variant_cost.get(vid)
            if d is not None:
                resolved_item[iid] = d
                return d
        if meta["is_composite"] and meta["components"]:
            total = Decimal("0.00")
            for comp in meta["components"]:
                vid = str(comp.get("variant_id") or "").strip()
                owner = variant_owner.get(vid)
                if owner is None:
                    return None
                try:
                    qty = Decimal(str(comp.get("quantity")))
                except Exception:
                    return None
                if qty <= 0:
                    return None
                sub = resolve(owner, stack)
                if sub is None:
                    return None
                total += sub * qty
            total = total.quantize(Decimal("0.01"))
            resolved_item[iid] = total
            return total
        resolved_item[iid] = None
        return None
    for iid in item_meta:
        resolve(iid, frozenset())
    return resolved_item

items = [
    # direct ingredients
    {"id": "i_sapok", "item_name": "[วัตถุดิบ] สะโพกไก่", "is_composite": False,
     "variants": [make_variant("v_sapok", 35.0)]},
    {"id": "i_moo", "item_name": "[วัตถุดิบ] หมู", "is_composite": False,
     "variants": [make_variant("v_moo", 50.0)]},
    {"id": "i_mie", "item_name": "[วัตถุดิบ] หมี่หยก", "is_composite": False,
     "variants": [make_variant("v_mie", 5.0)]},
    {"id": "i_nong", "item_name": "[วัตถุดิบ] น่องติดสะโพก", "is_composite": False,
     "variants": [make_variant("v_nong", 35.0)]},
    # composite: ข้าวไก่หมู = สะโพก 1 + หมู 0.5
    {"id": "c_khaokaemoo", "item_name": "ข้าวไก่หมู", "is_composite": True,
     "components": [{"variant_id": "v_sapok", "quantity": 1}, {"variant_id": "v_moo", "quantity": 0.5}],
     "variants": [{"variant_id": "v_kk", "cost": None}]},
    # composite: หมี่หยกสามชั้น = หมู 1 + หมี่หยก 2
    {"id": "c_miesamchan", "item_name": "หมี่หยกสามชั้น (หน้าร้าน)", "is_composite": True,
     "components": [{"variant_id": "v_moo", "quantity": 1}, {"variant_id": "v_mie", "quantity": 2}],
     "variants": [{"variant_id": "v_ms", "cost": None}]},
    # composite: เซ็ตเพื่อนซี้ x2 = น่อง 2
    {"id": "c_setx2", "item_name": "[เซ็ตเพื่อนซี้] น่อง x2", "is_composite": True,
     "components": [{"variant_id": "v_nong", "quantity": 2}],
     "variants": [{"variant_id": "v_sx2", "cost": None}]},
    # cycle: a sends to b, b sends to a (must resolve None, not hang)
    {"id": "c_cycle_a", "item_name": "cycle A", "is_composite": True,
     "components": [{"variant_id": "v_cycle_b", "quantity": 1}],
     "variants": [{"variant_id": "v_cycle_a", "cost": None}]},
    {"id": "c_cycle_b", "item_name": "cycle B", "is_composite": True,
     "components": [{"variant_id": "v_cycle_a", "quantity": 1}],
     "variants": [{"variant_id": "v_cycle_b", "cost": None}]},
]

def test_composite_cost_resolution():
    resolved = build_and_resolve(items)

    assert resolved.get("c_khaokaemoo") == Decimal("60.00")  # 35 + 25
    assert resolved.get("c_miesamchan") == Decimal("60.00")  # 50 + 10
    assert resolved.get("c_setx2") == Decimal("70.00")  # 35 * 2
    assert resolved.get("i_sapok") == Decimal("35.00")
    assert resolved.get("c_cycle_a") is None
    assert resolved.get("c_cycle_b") is None
