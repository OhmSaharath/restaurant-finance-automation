import csv
import io
import re
from collections import defaultdict
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional

from app.ingestion.base import (
    BaseSettlementParser,
    SettlementParsingError,
    parse_date,
    to_decimal,
)
from schemas.models import PlatformEnum


# Decoding order: UTF-8 (with/without BOM) first, then Thai TIS-620/CP874, then
# Latin-1 as a last resort. Line MAN exports from Thailand are frequently
# TIS-620; decoding those as UTF-8 (even with errors="replace") mangles the Thai
# header cells and breaks column detection.
_ENCODINGS = ("utf-8-sig", "cp874", "tis-620", "cp1252")


def _decode_bytes(content: bytes) -> str:
    for enc in _ENCODINGS:
        try:
            return content.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return content.decode("utf-8", errors="replace")


# Ordered (canonical_field, keywords) groups. Ordering matters for the
# score-based header picker below: a row matching many groups is the true
# column header, whereas a preamble summary row matches few.
_COLUMN_KEYWORDS: List[tuple] = [
    ("date", ["date", "วันที่", "report date", "order date", "transaction date", "settlement date", "capture time"]),
    ("restaurant_name", ["restaurant name", "restaurant", "\u0e23\u0e49\u0e32\u0e19\u0e04\u0e49\u0e32", "\u0e0a\u0e37\u0e48\u0e2d\u0e23\u0e49\u0e32\u0e19", "merchant", "merchant name", "store name", "shop name", "shop"]),
    ("branch_name", ["branch name", "branch", "\u0e2a\u0e32\u0e02\u0e32", "\u0e0a\u0e37\u0e48\u0e2d\u0e2a\u0e32\u0e02\u0e32"]),
    ("order_count", ["order count", "orders", "จำนวนออเดอร์", "จำนวนคำสั่งซื้อ", "รายการ", "count", "booking"]),
    ("gross_sales", ["gross sales", "gross", "ยอดขายรวม", "ยอดรวม", "total sales", "food sales", "ยอดขาย", "sales"]),
    ("cash_amount", ["cash amount", "cash", "cash sales amount"]),
    ("epay_amount", ["e payment amount", "epayment amount", "e payment"]),
    ("gp_amount", ["gp fee", "gp amount", "gp", "ค่าคอมมิชชั่น", "ค่าธรรมเนียม gp", "commission", "service fee", "fee"]),
    ("vat_amount", ["vat", "ภาษี", "ภาษีมูลค่าเพิ่ม", "vat 7%", "tax"]),
    ("promo_amount", ["promo", "promotion", "ส่วนลดร้านค้า", "discount", "merchant discount", "other cost", "โปรโมชัน"]),
    ("delivery_discount", ["delivery discount", "ส่วนลดค่าส่ง", "delivery"]),
    ("deductions", ["deductions", "total deduction", "ค่าธรรมเนียมรวม", "หักรวม", "total fee"]),
    ("net_sale", ["net sale", "net payout", "net", "ยอดโอนสุทธิ", "ยอดสุทธิ", "รายรับสุทธิ", "net amount", "payout", "balance"]),
    ("detail", ["detail", "transaction detail"]),
]


def _extract_date_from_filename(filename: Optional[str]) -> Optional[date]:
    """Derive the report date from e.g. 'Balance-Report-2026-09-01.csv'."""
    if not filename:
        return None
    m = re.search(r"(\d{4})-(\d{1,2})-(\d{1,2})", filename)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    return None


class LineManParser(BaseSettlementParser):
    """
    Parser for LINE MAN merchant settlement / balance report files (CSV).

    Robust against:
      - UTF-8-SIG / TIS-620 (CP874) / CP1252 encodings;
      - metadata preamble rows preceding the real column header;
      - a missing per-row date or shop column (derive from filename + preamble);
      - Thai (BE year), ISO, and DD/MM/YYYY date formats (via parse_date).
    """

    platform = PlatformEnum.LINE_MAN

    def parse(
        self,
        content: bytes | str,
        filename: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        text = _decode_bytes(content) if isinstance(content, bytes) else content
        reader = csv.reader(io.StringIO(text))
        rows = [row for row in reader if any(field.strip() for field in row)]

        if not rows:
            raise SettlementParsingError("LINE MAN settlement file is empty.")

        # ---- Dynamic header-row detection (score-based, over the preamble) ----
        # Score each candidate row by how many distinct column groups it matches;
        # the true header row matches the most groups. Requires >=2 groups to
        # avoid a metadata line being mistaken for the header.
        best_idx, best_score = -1, 0
        for i, row in enumerate(rows[:50]):
            row_lc = [c.strip().lower() for c in row]
            joined = " ".join(row_lc)
            score = 0
            for _field, kws in _COLUMN_KEYWORDS:
                if any(k in joined for k in kws):
                    score += 1
            if score > best_score:
                best_score, best_idx = score, i

        if best_idx == -1 or best_score < 2:
            raise SettlementParsingError(
                "Unable to locate LINE MAN column header row.",
                {"detected_preview": [r[:12] for r in rows[:10]]},
            )

        headers = [h.strip() for h in rows[best_idx]]
        col_map = self._map_columns(headers)
        data_rows = rows[best_idx + 1 :]

        # ---- Dynamic shop-name fallback (from preamble metadata) ----
        fallback_shop = self._detect_preamble_shop(rows[:best_idx])
        # If the report has no date column, derive it from the filename.
        fallback_date = _extract_date_from_filename(filename)

        # ---- Aggregate by (shop_name_raw, report_date) ----
        aggregated: Dict[tuple, Dict[str, Any]] = defaultdict(lambda: {
            "order_count": 0, "gross_sales": Decimal("0.00"), "deductions": Decimal("0.00"), "net_sale": Decimal("0.00"),
            "cash_amount": Decimal("0.00"), "epay_amount": Decimal("0.00"), "gp_amount": Decimal("0.00"),
            "ads_amount": Decimal("0.00"), "vat_amount": Decimal("0.00"), "promo_deductions": Decimal("0.00"), "delivery_discounts": Decimal("0.00")
        })

        seen_rows = 0
        for row in data_rows:
            if not any(row):
                continue

            # Skip Payout rows (they distort the order aggregation)
            detail_val = str(self._get_val(row, col_map.get("detail")) or "").lower()
            if "payout" in detail_val:
                continue

            is_ads = "listing ads" in detail_val

            raw_date = self._get_val(row, col_map.get("date"))
            # DROP TIMESTAMP: '2026-09-02 17:23:10' -> '2026-09-02'
            if raw_date:
                raw_date = str(raw_date).strip().split(" ")[0]

            # CONCATENATE RESTAURANT AND BRANCH
            rest_name = str(self._get_val(row, col_map.get("restaurant_name")) or "").strip()
            branch_name = str(self._get_val(row, col_map.get("branch_name")) or "").strip()

            raw_shop = f"{rest_name} {branch_name}".strip()

            if not raw_shop:
                raw_shop = fallback_shop or None

            report_date = parse_date(raw_date) if raw_date else fallback_date
            shop_name_raw = self._sanitize_shop_name(raw_shop)

            if report_date is None:
                continue

            cash = to_decimal(self._get_val(row, col_map.get("cash_amount")))
            epay = to_decimal(self._get_val(row, col_map.get("epay_amount")))
            gross = cash + epay if (cash + epay) > 0 else to_decimal(self._get_val(row, col_map.get("gross_sales")))

            raw_gp = abs(to_decimal(self._get_val(row, col_map.get("gp_amount"))))
            gp = Decimal("0.00") if is_ads else raw_gp
            ads = raw_gp if is_ads else Decimal("0.00")

            vat = abs(to_decimal(self._get_val(row, col_map.get("vat_amount"))))
            promo = abs(to_decimal(self._get_val(row, col_map.get("promo_amount"))))
            delivery = abs(to_decimal(self._get_val(row, col_map.get("delivery_discount"))))

            order_cnt = int(to_decimal(self._get_val(row, col_map.get("order_count")), Decimal("1")))

            raw_deductions = self._get_val(row, col_map.get("deductions"))
            raw_net = self._get_val(row, col_map.get("net_sale"))

            calculated_deductions = gp + ads + vat + promo + delivery
            deductions = abs(to_decimal(raw_deductions)) if raw_deductions else calculated_deductions
            net = to_decimal(raw_net) if raw_net else (gross - deductions)

            if gross == 0 and deductions == 0 and net == 0 and order_cnt == 0:
                continue

            seen_rows += 1
            key = (shop_name_raw, report_date)
            agg = aggregated[key]
            agg["order_count"] += order_cnt
            agg["gross_sales"] += gross
            agg["deductions"] += deductions
            agg["net_sale"] += net
            agg["cash_amount"] += cash
            agg["epay_amount"] += epay
            agg["gp_amount"] += gp
            agg["ads_amount"] += ads
            agg["vat_amount"] += vat
            agg["promo_deductions"] += promo
            agg["delivery_discounts"] += delivery

        if not aggregated:
            # Fail LOUDLY with the actual header row so the operator can see the
            # real column names instead of a generic NO_RECORDS_FOUND.
            raise SettlementParsingError(
                "No data rows extracted from LINE MAN report; check column mapping.",
                {
                    "header_row": headers,
                    "mapped_columns": dict(col_map),
                    "data_rows_seen": len(data_rows),
                    "filename": filename,
                },
            )

        results = []
        for (shop_name_raw, report_date), agg in aggregated.items():
            gross_final = agg["gross_sales"].quantize(Decimal("0.01"))
            deductions_final = agg["deductions"].quantize(Decimal("0.01"))
            net_final = agg["net_sale"].quantize(Decimal("0.01"))

            # Enforce NUMERIC(12,2) integrity: net == gross - deductions.
            expected_net = (gross_final - deductions_final).quantize(Decimal("0.01"))
            net_final = expected_net

            results.append({
                "platform": PlatformEnum.LINE_MAN,
                "report_date": report_date,
                "shop_name_raw": shop_name_raw,
                "order_count": max(0, agg["order_count"]),
                "gross_sales": gross_final,
                "deductions": deductions_final,
                "net_sale": net_final,
                "details": {
                    "source_platform": "LINE MAN",
                    "filename": filename,
                    "payment": {
                        "Cash": float(agg["cash_amount"]),
                        "E-Payment": float(agg["epay_amount"])
                    },
                    "deductions": {
                        "GP Fee (Before VAT)": float(agg["gp_amount"]),
                        "Listing Ads (Before VAT)": float(agg["ads_amount"]),
                        "Promotions & Marketing (Before VAT)": float(agg["promo_deductions"]),
                        "VAT": float(agg["vat_amount"])
                    }
                },
            })

        return results

    def _detect_preamble_shop(self, preamble_rows: List[List[str]]) -> str:
        """Extract a merchant/shop name from metadata lines above the header."""
        # Merchant-label prefixes. English tokens are matched directly; Thai
        # (TIS-620) preamble merchant lines are intentionally NOT hardcoded here
        # (script literals are unreliable across editors), so a Thai preamble
        # simply yields an empty fallback and the row keeps its per-column shop
        # name or resolves to None via _sanitize_shop_name.
        shop_labels = ("merchant", "shop", "store")
        for row in preamble_rows:
            for cell in row:
                c = cell.strip()
                if not c:
                    continue
                low = c.lower()
                # e.g. "Merchant: ..." or "<Thai-label>: ..."
                m = re.match(r"^([a-z\u0e00-\u0e7f ]{1,16}?)[:：]\s*(.+)$", low)
                if m:
                    label = m.group(1).strip()
                    if label and any(k in label for k in shop_labels):
                        return m.group(2).strip()
        return ""

    # Substrings that indicate we have NOT captured a real shop name but
    # rather a report filename or generic label we must never persist.
    _FILENAME_LIKE = ("balance-report", "settlement", ".csv", ".xlsx", ".xls", "report.csv")

    def _sanitize_shop_name(self, raw_shop: Optional[str]) -> Optional[str]:
        """Return a clean, non-filename shop name, or None when nothing real.

        Guards against the settlement pipeline ever writing a downloaded
        attachment filename (e.g. ``Balance-Report-2026-09-06.csv``) into
        ``raw_shop_name``. If the value is empty, clearly a filename, or a
        generic label, ``None`` is returned instead (``daily_reports.shop_name_raw``
        is nullable in the live schema).
        """
        if not raw_shop:
            return None
        val = raw_shop.strip()
        if not val:
            return None
        low = val.lower()
        # A trailing extension or an embedded filename marker is not a shop.
        if low.endswith((".csv", ".xlsx", ".xls")):
            return None
        if any(marker in low for marker in self._FILENAME_LIKE):
            return None
        return val

    def _map_columns(self, headers: List[str]) -> Dict[str, int]:
        mapping: Dict[str, int] = {}
        for idx, h in enumerate(headers):
            clean = h.lower().replace("_", " ").replace("-", " ")
            for field, kws in _COLUMN_KEYWORDS:
                if field in mapping:
                    continue
                if any(k in clean for k in kws):
                    mapping[field] = idx
                    break
        return mapping


    def _get_val(self, row: List[str], idx: Optional[int]) -> Optional[str]:
        if idx is not None and 0 <= idx < len(row):
            return row[idx].strip()
        return None
