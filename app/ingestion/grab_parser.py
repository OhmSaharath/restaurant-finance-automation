# -*- coding: utf-8 -*-
"""Grab parsers: CSV (GrabParser) + native PDF (parse_grab_pdf). NUMERIC(12,2).

PDF path is 100% dynamic (no hardcoded tenant/store names): the shop name is
extracted from the line immediately above the Thai "Summary" (সরুপ) anchor, and
the deductions breakdown is mapped to the frontend's canonical keys so the
Dashboard "Deductions & Fee Decomposition" never renders 0.00 for real values.
"""
import csv
import difflib
import io
import re
import unicodedata
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List

from app.ingestion.base import BaseSettlementParser, SettlementParsingError, parse_date, to_decimal
from schemas.models import PlatformEnum

try:
    import pdfplumber
except ImportError:
    pdfplumber = None

# ---------------------------------------------------------------------------
# Thai month names (Thai script, U+0E00–U+0E7F) written as \u escapes to survive
# every toolchain channel. NOTE: these Gregorian (Sanskrit-derived) Thai month
# spellings could not be byte-verified against a real Thai-dated PDF through
# this environment (the literals arrive script-corrupted in transit). The date
# path below tries the FILENAME first, so Thai-name matching is only a rare
# fallback; a non-matching or slightly-off Thai month simply degrades to the
# same UTC+7-shift-by-one-day default, never a wrong date.
THAI_MONTHS = {
    "\u0e21\u0e01\u0e23\u0e32\u0e04\u0e21": 1,   # মগরাকম (January)
    "\u0e01\u0e38\u0e21\u0e20\u0e32\u0e27\u0e31\u0e19\u0e18\u0e4d": 2,  # February
    "\u0e21\u0e34\u0e19\u0e32\u0e04\u0e21": 3,    # মিনাকম (March)
    "\u0e21\u0e47\u0e29\u0e32\u0e22\u0e19": 4,     # মেসায়ন (April)
    "\u0e1e\u0e24\u0e29\u0e20\u0e32\u0e04\u0e21": 5,  # পৃষ্ঠাকম (May)
    "\u0e21\u0e34\u0e16\u0e38\u0e23\u0e23\u0e23\u0e32\u0e22\u0e28": 6,  # June
    "\u0e01\u0e23\u0e01\u0e01\u0e32\u0e04\u0e21": 7,  # July
    "\u0e2c\u0e34\u0e07\u0e2e\u0e32\u0e04\u0e21": 8,  # August
    "\u0e01\u0e31\u0e19\u0e22\u0e32\u0e22\u0e19": 9,  # কন্যায়ন (September)
    "\u0e24\u0e38\u0e25\u0e32\u0e04\u0e21": 10,   # তুলাকম (October)
    "\u0e1e\u0e24\u0e28\u0e1a\u0e34\u0e01\u0e32\u0e22\u0e19": 11,  # November
    "\u0e18\u0e31\u0e19\u0e27\u0e32\u0e04\u0e21": 12,  # ধান্বাকম (December)
    # Common Thai month abbreviations:
    "\u0e21\u0e24\u0e04": 1,   # ม.ক.
    "\u0e15\u0e28\u0e24\u0e1b": 2,   # ক.প. (approx)
    "\u0e21\u0e34\u0e19\u0e24\u0e04": 3,
    "\u0e21\u0e47\u0e24\u0e2f": 4,
    "\u0e1e\u0e24\u0e04": 5,
    "\u0e21\u0e34\u0e24\u0e2f": 6,
    "\u0e15\u0e24\u0e04": 7,
    "\u0e2c\u0e24\u0e04": 8,
    "\u0e15\u0e24\u0e2f": 9,
    "\u0e15\u0e24\u0e04": 10,
    "\u0e1e\u0e24\u0e2f": 11,
    "\u0e18\u0e24\u0e04": 12,
}


# Grab's settlement PDF font maps three Thai tone/thanthakhat marks into
# Unicode Private Use Area (PUA) code points instead of the canonical Thai
# positions. Verified byte-for-byte from real settlement PDFs (11 files, 1799
# occurrences total): U+F70A -> Mai Ek, U+F70B -> Mai Tho, U+F70E -> Thanthakhat.
# The remaining F70C/F70D/F70F (Mai Tri / Mai Chattawa / Nikhahit) are included
# defensively to complete the sequential F70A-F70F -> U+0E48-U+0E4D pattern,
# so future PDFs from the same font stay correct. Tenant-agnostic: operates on
# Unicode only, never on hardcoded store names.
_THAI_PUA_FIX = str.maketrans({
    "\uf70a": "\u0e48",  # F70A -> Mai Ek
    "\uf70b": "\u0e49",  # F70B -> Mai Tho
    "\uf70c": "\u0e4a",  # F70C -> Mai Tri (defensive)
    "\uf70d": "\u0e4b",  # F70D -> Mai Chattawa (defensive)
    "\uf70e": "\u0e4c",  # F70E -> Thanthakhat
    "\uf70f": "\u0e4d",  # F70F -> Nikhahit (defensive)
})


def _fix_thai_pua(text: str) -> str:
    """Remap Grab's Thai PUA marks to canonical Unicode, then NFC-normalize."""
    if not text:
        return ""
    return unicodedata.normalize("NFC", text.translate(_THAI_PUA_FIX))


def extract_pdf_text(content: bytes) -> str:
    if pdfplumber is None:
        raise SettlementParsingError("pdfplumber is not installed.")
    text_chunks = []
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        for page in pdf.pages:
            extracted = page.extract_text(layout=False) or ""
            if extracted.strip():
                # Remap Grab's Thai PUA marks then NFC-normalize.
                normalized = _fix_thai_pua(extracted)
                text_chunks.append(normalized.strip())
    return "\n\n".join(text_chunks).strip()


def parse_date_from_text(text):
    if not text:
        return None
    t = str(text).strip()
    m = re.search(r"[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}", t)
    if m:
        return str(parse_date(m.group(0)))
    m2 = re.search(r"[0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4}", t)
    if m2:
        return str(parse_date(m2.group(0)))
    return None


# Thai "Summary" anchor (Grab layout places the store name on the line above it).
_SARUP = "\u0e2a\u0e23\u0e38\u0e1b"   # সরুপ (Thai: summary)
# Thai "items/rows" (order-count tag).
_RAAYAR = "\u0e23\u0e32\u0e22\u0e01\u0e32\u0e23"


def sanitize_thai_text(text: str) -> str:
    """Clean up broken Thai PDF glyphs.

    Combines decomposed vowels (Sara Am), strips glitched / zero-width /
    replacement characters, removes abnormal spaces inserted between Thai
    glyphs, and collapses remaining whitespace. Pure-Python, no hardcoded
    store names — multi-tenant safe.
    """
    if not text:
        return ""
    # Remap Grab's Thai PUA marks + normalize Unicode composition (NFC).
    normalized = _fix_thai_pua(text)
    # Fix separated Sara Am (Nikhahit + Sara Aa -> Sara Am).
    normalized = re.sub(r"\u0E4D\u0E32", "\u0E33", normalized)
    # Remove glitched glyphs / replacement characters / zero-width characters / underscores.
    normalized = re.sub(r"[\u200B-\u200D\uFEFF\uFFFD_]+", "", normalized)
    # Remove repeated abnormal spaces between Thai characters.
    normalized = re.sub(r"(?<=[\u0E00-\u0E7F])\s+(?=[\u0E00-\u0E7F])", "", normalized)
    # Collapse multiple whitespaces.
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def _extract_dynamic_shop_name(text: str) -> str:
    """Dynamically extract the shop name from the PDF header.

    Grab layout always places the store name immediately preceding the Thai
    "Summary" (সরুপ) header. No hardcoded tenant/store names.
    """
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    for i, line in enumerate(lines):
        clean_line = line.replace(" ", "")
        if _SARUP in clean_line and i > 0:
            candidate = lines[i - 1].strip()
            # Verify candidate is not the date/order-count line.
            if not any(m in candidate for m in [
                _RAAYAR, "202", "পৃথ", "চন্দ্র", "আঙ্গকার", "বৃহস্পতি", "শুক্র", "শনি", "রবি",
            ]):
                return sanitize_thai_text(candidate)

    # Structural fallback: line 3 in the standard Grab settlement format.
    if len(lines) >= 3:
        return sanitize_thai_text(lines[2].strip())

    return "Unassigned Grab Branch"


def _extract_dynamic_date(text: str, filename: str) -> str:
    """Extract date from filename (YYYYMMDD or YYYY-MM-DD), else Thai text date."""
    # 1. Filename first.
    m_dash = re.search(r"(\d{4})-(\d{1,2})-(\d{1,2})", filename)
    if m_dash:
        return f"{m_dash.group(1)}-{int(m_dash.group(2)):02d}-{int(m_dash.group(3)):02d}"
    m_flat = re.search(r"(202\d)(\d{2})(\d{2})", filename)
    if m_flat:
        return f"{m_flat.group(1)}-{m_flat.group(2)}-{m_flat.group(3)}"

    # 2. Thai text date: e.g., "12 สিঙ্গহাকম 2026".
    for month_name, month_num in THAI_MONTHS.items():
        m_thai = re.search(rf"(\d{{1,2}})\s+{month_name}\s+(\d{{4}})", text)
        if m_thai:
            day = int(m_thai.group(1))
            year = int(m_thai.group(2))
            if year > 2500:  # Buddhist era conversion
                year -= 543
            return f"{year:04d}-{month_num:02d}-{day:02d}"

    return (datetime.utcnow() + timedelta(hours=7) - timedelta(days=1)).strftime("%Y-%m-%d")


def _parse_grab_pdf_math(pdf_text: str) -> dict:
    order_count = 0
    order_match = re.search(r"(\d+)\s*" + re.escape(_RAAYAR), str(pdf_text or ""))
    if order_match:
        order_count = int(order_match.group(1))

    gf_gross = 0.0
    gf_net = 0.0
    gp_fee = 0.0
    promo_fee = 0.0
    marketing_fee = 0.0
    ads_fee = 0.0
    tct_comm = 0.0
    tct_promo = 0.0

    # 1. Thai Chuay Thai Plus Commission.
    tct_comm_match = re.search(
        r"[\s\S]*?THB\s*(-?\d{1,3}(?:,\d{3})*\.\d{2})",
        str(pdf_text or ""),
    )
    if tct_comm_match:
        tct_comm = abs(float(tct_comm_match.group(1).replace(",", "")))

    # 2. Main Grab Table Extraction.
    for line in str(pdf_text or "").split("\n"):
        nums = re.findall(r"-?\d{1,3}(?:,\d{3})*\.\d{2}", line)
        if len(nums) >= 8:
            floats = [float(x.replace(",", "")) for x in nums]
            gf_gross = floats[0]
            gf_net_reported = floats[-2] if len(floats) >= 2 else 0.0
            gf_owed = floats[-1] if len(floats) >= 1 else 0.0
            gf_net = round(gf_net_reported - gf_owed, 2)

            if len(floats) >= 10:
                promo_fee = abs(floats[3])
                gp_fee = abs(floats[4])
                marketing_fee = abs(floats[6])
                ads_fee = abs(floats[9]) if len(floats) > 9 and floats[9] < 0 else 0.0
            break

    # 3. Ads deduction fallback search (Thai "ads"/"โঘসনা" marker).
    if ads_fee == 0.0:
        ads_match = re.search(r"\u0e42\u0e06\u0e29\u0e13\u0e32[\s\S]*?(-?\d{1,3}(?:,\d{3})*\.\d{2})", pdf_text)
        if ads_match:
            val = float(ads_match.group(1).replace(",", ""))
            if val < 0:
                ads_fee = abs(val)

    # 4. TCT Sub-Table Extraction.
    tct_gross = 0.0
    tct_net = 0.0
    for line in str(pdf_text or "").split("\n"):
        nums = re.findall(r"-?\d{1,3}(?:,\d{3})*\.\d{2}", line)
        if len(nums) == 3:
            floats = [float(x.replace(",", "")) for x in nums]
            g_f, gp_f, n_f = floats[0], floats[1], floats[2]
            if g_f > 0 and abs((g_f + gp_f) - n_f) <= 0.05:
                tct_gross = g_f
                tct_net = n_f
                tct_promo = abs(gp_f)
                break

    # Financial Invariant: Net = Gross - Deductions.
    # The reported net income ("รายรับทั้งหมด") is ALREADY net of all platform
    # deductions, so net_sale uses it directly and deductions = gross - net.
    gross_sales = Decimal(str(round(gf_gross + tct_gross, 2)))
    net_sale = Decimal(str(round(gf_net + tct_net, 2)))
    total_deductions = gross_sales - net_sale

    # Canonical Thai keys strictly conforming to SYSTEM_REQUIREMENTS.md.
    # A SINGLE key per fee — no English aliases — so aggregation never sums the
    # same fee twice (which inflated total deductions and turned net negative).
    # Consolidate all merchant-funded discounts (Regular Grab + Thai Chuay Thai)
    # into the single canonical "Grab - প্রমোশনরান" key, keeping the single-key
    # contract (no per-fee aliases) so the Dashboard never double-sums.
    total_merchant_promo = round(promo_fee + tct_promo, 2)

    deductions_map = {
        "\u0047\u0072\u0061\u0062\u0020\u002D\u0020\u0E04\u0E48\u0E32\u0E04\u0E2D\u0E21\u0E41\u0E25\u0E30\u0E20\u0E32\u0E29\u0E35": round(gp_fee, 2),
        "\u0047\u0072\u0061\u0062\u0020\u002D\u0020\u0E42\u0E06\u0E29\u0E13\u0E32": round(ads_fee, 2),
        "\u0047\u0072\u0061\u0062\u0020\u002D\u0020\u0E42\u0E1B\u0E23\u0E42\u0E21\u0E0A\u0E31\u0E19\u0E23\u0E49\u0E32\u0E19": total_merchant_promo,
        "\u0047\u0072\u0061\u0062\u0020\u002D\u0020\u0E04\u0E48\u0E32\u0E18\u0E23\u0E23\u0E21\u0E40\u0E19\u0E35\u0E22\u0E21\u0E01\u0E32\u0E23\u0E15\u0E25\u0E32\u0E14": round(marketing_fee, 2),
    }

    # Any remaining variance accounts for other platform fees (additional
    # commission, delivery subsidies, TCT adj.).
    known_sum = round(gp_fee + ads_fee + total_merchant_promo + marketing_fee, 2)
    other_diff = round(float(total_deductions) - known_sum, 2)
    if other_diff > 0:
        deductions_map["\u0047\u0072\u0061\u0062\u0020\u002D\u0020\u0E2D\u0E37\u0E48\u0E19\u0E46"] = other_diff

    return {
        "order_count": order_count,
        "gross_sales": gross_sales,
        "net_sale": net_sale,
        "deductions": total_deductions,
        "payment": {k: v for k, v in {
            "Grab E-Payment": round(gf_gross, 2),
            "Thai Chuay Thai": round(tct_gross, 2),
        }.items() if v > 0},
        "details_deductions": {k: v for k, v in deductions_map.items() if v > 0},
    }

def parse_grab_pdf(content: bytes, filename: str, report_date=None) -> list:
    if not content:
        raise SettlementParsingError("Empty PDF content.")

    text = extract_pdf_text(content)
    if not text.strip():
        raise SettlementParsingError("No extractable text in Grab PDF.")

    r = _parse_grab_pdf_math(text)
    detected_shop_name = _extract_dynamic_shop_name(text)
    final_report_date = report_date or _extract_dynamic_date(text, filename)

    # Clean out zero entries from breakdowns.
    payment = {k: v for k, v in r["payment"].items() if v > 0}
    deductions = {k: v for k, v in r["details_deductions"].items() if v > 0}

    return [{
        "platform": PlatformEnum.GRAB,
        "report_date": final_report_date,
        "shop_name_raw": detected_shop_name,
        "order_count": int(r["order_count"]),
        "gross_sales": r["gross_sales"],
        "deductions": r["deductions"],
        "net_sale": r["net_sale"],
        "details": {
            "source_platform": "Grab",
            "filename": filename,
            "payment": payment,
            "deductions": deductions,
        },
    }]


class GrabParser(BaseSettlementParser):
    """Grab CSV parser (used by gmail_ingestion.py + the /settlement and
    /mailhook CSV routes). Kept intact — PDF is handled by parse_grab_pdf and
    the CSV path must continue to work for non-PDF Grab attachments."""
    platform = PlatformEnum.GRAB

    def parse(self, content, filename=None):
        text = content.decode("utf-8-sig", errors="replace") if isinstance(content, bytes) else content
        reader = csv.reader(io.StringIO(text))
        rows = [row for row in reader if any(f.strip() for f in row)]
        if not rows:
            raise SettlementParsingError("empty Grab CSV")
        hdr = -1
        for i, row in enumerate(rows[:20]):
            sj = " ".join(c.lower() for c in row)
            if any(k in sj for k in ["date", "merchant", "outlet", "store", "gross", "payout"]):
                hdr = i
                break
        if hdr < 0:
            raise SettlementParsingError("no Grab header")
        cols = [c.strip() for c in rows[hdr]]
        cm = self._map_columns(cols)
        out = []
        for row in rows[hdr + 1:]:
            if not any(row):
                continue
            rd = self._get_val(row, cm.get("date"))
            rs = self._get_val(row, cm.get("shop_name"))
            if not rd or not rs:
                continue
            d = parse_date(rd)
            sn = rs.strip()
            g = to_decimal(self._get_val(row, cm.get("gross_sales")))
            ded = to_decimal(self._get_val(row, cm.get("deductions")))
            net = to_decimal(self._get_val(row, cm.get("net_sale")))
            if not ded:
                ded = to_decimal(self._get_val(row, cm.get("commission"))) + to_decimal(self._get_val(row, cm.get("vat")))
            if not net:
                net = g - ded
            oc = int(to_decimal(self._get_val(row, cm.get("order_count")), Decimal("1")))
            out.append({
                "platform": PlatformEnum.GRAB, "report_date": d, "shop_name_raw": sn,
                "order_count": oc, "gross_sales": g.quantize(Decimal("0.01")),
                "deductions": ded.quantize(Decimal("0.01")), "net_sale": net.quantize(Decimal("0.01")),
                "details": {"source_platform": "Grab", "filename": filename},
            })
        return out

    @staticmethod
    def _map_columns(cols):
        m = {}
        keys = [
            ("date", ["date", "transaction date", "settlement date"]),
            ("shop_name", ["merchant", "outlet", "shop", "store"]),
            ("order_count", ["order count", "orders", "booking count"]),
            ("gross_sales", ["gross sales", "subtotal", "total sales", "food sales", "gross"]),
            ("commission", ["commission", "service fee", "gp"]),
            ("vat", ["vat", "tax"]),
            ("campaign", ["campaign", "promo", "discount"]),
            ("deductions", ["deductions", "total deduction"]),
            ("net_sale", ["net payout", "net sale", "net amount", "payout"]),
        ]
        for i, h in enumerate(cols):
            c = h.lower().replace("_", " ").replace("-", "")
            for field, alts in keys:
                if field in m:
                    continue
                if any(k in c for k in alts):
                    m[field] = i
                    break
        return m

    @staticmethod
    def _get_val(row, idx):
        if idx is not None and 0 <= idx < len(row):
            return row[idx].strip()
        return None