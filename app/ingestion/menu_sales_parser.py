"""Menu-sales parsers: Grab CSV + LINE MAN XLSX (Phase 1).

Each parser returns a normalized list of per-item sale records:

    {
      "platform": "Grab" | "LINE MAN",
      "branch_name": str | None,      # None for LINE MAN all-branches
      "report_date": "YYYY-MM-DD",    # iso str
      "raw_item_name": str,
      "quantity": Decimal,
      "item_gross": Decimal | None,   # sales THB from the file; None if absent
    }

Financial guardrail: money is NUMERIC(12,2) / Decimal. item_gross is taken
verbatim from the source file and never defaulted to 0.00 — a cell that cannot
be parsed to a number yields item_gross=None (caller leaves it NULL), it is
never silently coerced to zero.

Thai literals in this module are written as pure-ASCII \\uXXXX escapes because
the edit channel mojibakes raw Thai/Bengali through file writes. Ground truth
for every keyword below was byte-verified from the actual sample files
(samples/report_grab/*.csv, samples/report_lineman/*.xlsx).
"""
import csv
import io
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Thai header keywords for the Grab Menu Sales CSV (U+0E00–U+0E7F), verified
# from the on-disk sample header (codes below are the Thai codepoints):
#   date     = \u0e27\u0e31\u0e19\u0e17\u0e35\u0e48
#   branch   = \u0e23\u0e49\u0e32\u0e19
#   item     = \u0e23\u0e32\u0e22\u0e01\u0e32\u0e23
#   quantity = \u0e08\u0e33\u0e19\u0e27\u0e19\u0e17\u0e35\u0e48\u0e02\u0e32\u0e22\u0e44\u0e14\u0e49
#   gross    = \u0e22\u0e2d\u0e14\u0e02\u0e32\u0e22\u0e17\u0e35\u0e48\u0e17\u0e33\u0e44\u0e14\u0e49  (suffix is the Thai baht sign: U+0E3F)
# Matching is by substring so the parenthetical (baht-sign) suffix on the gross
# column header is naturally tolerated.
_K_DATE = "\u0e27\u0e31\u0e19\u0e17\u0e35\u0e48"                    # Thai: date
_K_BRANCH = "\u0e23\u0e49\u0e32\u0e19"                            # Thai: branch
_K_ITEM = "\u0e23\u0e32\u0e22\u0e01\u0e32\u0e23"                 # Thai: item
_K_QUANTITY = "\u0e08\u0e33\u0e19\u0e27\u0e19\u0e17\u0e35\u0e48\u0e02\u0e32\u0e22\u0e44\u0e14\u0e49"  # Thai: quantity sold
_K_GROSS = "\u0e22\u0e2d\u0e14\u0e02\u0e32\u0e22\u0e17\u0e35\u0e48\u0e17\u0e33\u0e44\u0e14\u0e49"      # Thai: gross sales

_DECODE_ORDER = ("utf-8-sig", "utf-8", "cp874", "tis-620", "cp1252")


class MenuSalesParseError(ValueError):
    """Raised when a menu-sales file cannot be parsed (mapped to a 4xx)."""


def _decode(content: bytes) -> str:
    for enc in _DECODE_ORDER:
        try:
            return content.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return content.decode("utf-8", errors="replace")


def _to_decimal(value: Any) -> Optional[Decimal]:
    """Parse a cell to Decimal or None. Never fabricate 0.00 for a bad value."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        d = Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, ValueError, TypeError):
        return None
    if not d.is_finite():
        return None
    return d


def _parse_date_dmY(raw: str) -> Optional[str]:
    """Parse DD/MM/YYYY (Grab in-file date) to YYYY-MM-DD iso; None if invalid."""
    if not raw:
        return None
    m = re.search(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", raw.strip())
    if not m:
        return None
    day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        return datetime(year, month, day).strftime("%Y-%m-%d")
    except ValueError:
        return None


def _find_header_index(rows: List[List[str]]) -> int:
    """Locate the row that carries all four Thai menu-sales keywords."""
    for i, row in enumerate(rows[:50]):
        joined = " ".join(c.strip() for c in row)
        score = sum(1 for k in (_K_DATE, _K_BRANCH, _K_ITEM, _K_QUANTITY, _K_GROSS) if k in joined)
        if score >= 3:
            return i, score
    return -1, 0


def parse_grab_menu_sales(content: bytes, filename: str) -> List[Dict[str, Any]]:
    """Parse a Grab Menu Sales CSV into per-item sale records.

    Uses the in-file date column (DD/MM/YYYY) and the branch column; the CSV
    filename range is ignored (Grab reports may span several dates). One record
    per CSV row — no grouping happens here. Date and branch come from the file,
    not the filename.
    """
    text = _decode(content)
    reader = csv.reader(io.StringIO(text))
    rows = [row for row in reader if any(cell.strip() for cell in row)]
    if not rows:
        raise MenuSalesParseError("Grab menu-sales file is empty.")

    header_idx, score = _find_header_index(rows)
    if header_idx < 0:
        raise MenuSalesParseError(
            "Could not locate the Grab Menu Sales header row (expected Thai date / "
            "branch / item / quantity / gross columns)."
        )
    headers = rows[header_idx]
    ncols = len(headers)

    def col_idx(*keys: str) -> Optional[int]:
        for i, h in enumerate(headers):
            if any(k in h for k in keys):
                return i
        return None

    date_col = col_idx(_K_DATE)
    branch_col = col_idx(_K_BRANCH)
    item_col = col_idx(_K_ITEM)
    qty_col = col_idx(_K_QUANTITY)
    gross_col = col_idx(_K_GROSS)

    if item_col is None or date_col is None or qty_col is None:
        raise MenuSalesParseError(
            "Grab Menu Sales header is missing date / item / quantity columns. "
            f"Detected columns: {headers}"
        )

    records: List[Dict[str, Any]] = []
    for row in rows[header_idx + 1:]:
        if len(row) < ncols:
            row = row + [""] * (ncols - len(row))
        raw_item = row[item_col].strip() if item_col < len(row) else ""
        if not raw_item:
            continue
        raw_date = row[date_col].strip() if date_col is not None and date_col < len(row) else ""
        report_date = _parse_date_dmY(raw_date)
        if report_date is None:
            report_date = raw_date  # preserve unparseable date verbatim; caller validates
        quantity = _to_decimal(row[qty_col]) if qty_col is not None and qty_col < len(row) else None
        quantity = Decimal(str(int(quantity))) if quantity is not None and quantity == quantity.to_integral_value() else quantity
        item_gross = (
            _to_decimal(row[gross_col])
            if gross_col is not None and gross_col < len(row)
            else None
        )
        branch = row[branch_col].strip() if branch_col is not None and branch_col < len(row) else ""
        records.append(
            {
                "platform": "Grab",
                "branch_name": branch or None,
                "report_date": report_date,
                "raw_item_name": raw_item,
                "quantity": quantity if quantity is not None else Decimal("0.00"),
                "item_gross": item_gross,
            }
        )

    if not records:
        raise MenuSalesParseError("No item rows found in Grab menu-sales CSV.")

    return records


# ---------------------------------------------------------------------------
# LINE MAN (single-day files only)
# ---------------------------------------------------------------------------
# Thai "" = to (range separator) — used to reject multi-day filenames.
_THUNG = "\u0e16\u0e36\u0e07"  #
_RANGE_DATE_SPLIT_RE = re.compile(r"(19|20)\d{2}\s*[-–—_]\s*(19|20)\d{2}")
_MULTI_DATE_8DIGIT_RE = re.compile(
    r"(?:(?<=^)|(?<=[\D]))(19|20)\d{2}(0[1-9]|1[0-2])([0-2]\d|3[01])(?=(?:[\D])|$)"
)


def parse_lineman_menu_sales(content: bytes, filename: str) -> List[Dict[str, Any]]:
    """Parse a LINE MAN item-sales XLSX into per-item sale records.

    Supports SINGLE-DAY files only (spec lock #4). The date comes exclusively
    from the filename via ``YYYYMMDD`` or ``YYYY-MM-DD``. A range filename —
    two separated dates, or containing the Thai word "" / English "to" —
    is REJECTED with a clear "please download daily" message; we never
    average/fabricate per-day figures.

    Column contract: sheet "menuItems" (or first sheet) with columns
    ``menuName``, ``amount``, ``sales``. item_gross = sales.
    """
    import pandas as pd  # local import: heavy (openpyxl) — only for LINE MAN path

    if not content:
        raise MenuSalesParseError("LINE MAN menu-sales file is empty.")

    # ---- Date / range detection from the filename --------------------------
    if not filename:
        raise MenuSalesParseError(
            "LINE MAN menu-sales requires a filename carrying a single date "
            "(e.g. ..._20260910.xlsx). The date has no other source."
        )
    stem = filename.rsplit(".", 1)[0] if "." in filename else filename
    if _THUNG in stem or re.search(r"\bto\b", stem, re.IGNORECASE):
        raise MenuSalesParseError(
            "LINE MAN menu-sales supports single-day files only. This filename "
            "looks like a date range (contains '"
            + _THUNG
            + "'/\"to\"). Please download a daily file."
        )
    if _RANGE_DATE_SPLIT_RE.search(stem):
        raise MenuSalesParseError(
            "LINE MAN menu-sales supports single-day files only. This filename "
            "contains a date range. Please download a daily file."
        )
    dates = _MULTI_DATE_8DIGIT_RE.findall(stem)
    if len(dates) > 1:
        raise MenuSalesParseError(
            "LINE MAN menu-sales supports single-day files only. Multiple dates "
            "detected in the filename. Please download a daily file."
        )
    date_match = None
    # YYYY-MM-DD first (also tolerates YYYY/MM/DD), then contiguous YYYYMMDD.
    m_dash = re.search(r"\b((?:19|20)\d{2})[-/](\d{2})[-/](\d{2})\b", stem)
    if m_dash:
        y, mo, d = int(m_dash.group(1)), int(m_dash.group(2)), int(m_dash.group(3))
        try:
            date_match = datetime(y, mo, d).strftime("%Y-%m-%d")
        except ValueError:
            date_match = None
    if date_match is None:
        m_flat = re.search(r"((?:19|20)\d{2})([01]\d)([0-3]\d)", stem)
        if m_flat:
            y, mo, d = int(m_flat.group(1)), int(m_flat.group(2)), int(m_flat.group(3))
            try:
                date_match = datetime(y, mo, d).strftime("%Y-%m-%d")
            except ValueError:
                date_match = None
    if date_match is None:
        raise MenuSalesParseError(
            "LINE MAN menu-sales requires a single YYYYMMDD or YYYY-MM-DD date "
            f"in the filename; none found in {filename!r}."
        )

    # ---- Read the workbook ------------------------------------------------
    try:
        xls = pd.ExcelFile(io.BytesIO(content))
        sheet = "menuItems" if "menuItems" in xls.sheet_names else xls.sheet_names[0]
        df = xls.parse(sheet)
    except Exception as exc:  # noqa: BLE001 - normalized below
        raise MenuSalesParseError(f"LINE MAN menu-sales could not be read as an Excel file: {exc}")

    if df is None or df.empty:
        raise MenuSalesParseError("LINE MAN menu-sales sheet is empty.")
    if not list(df.columns):
        raise MenuSalesParseError("LINE MAN menu-sales sheet has no columns.")

    cols = {str(c).strip().lower(): c for c in df.columns}
    name_col = cols.get("menuname")
    qty_col = cols.get("amount") or cols.get("quantity")
    gross_col = cols.get("sales")
    if name_col is None or qty_col is None:
        raise MenuSalesParseError(
            "LINE MAN menu-sales requires 'menuName' and 'amount' columns "
            f"(and optional 'sales'). Found: {list(df.columns)}"
        )

    records: List[Dict[str, Any]] = []
    for _, rec in df.iterrows():
        raw_item = str(rec[name_col]).strip() if rec[name_col] is not None else ""
        if not raw_item:
            continue
        quantity = _to_decimal(rec[qty_col])
        item_gross = _to_decimal(rec[gross_col]) if gross_col is not None else None
        records.append(
            {
                "platform": "LINE MAN",
                "branch_name": None,  # all-branches
                "report_date": date_match,
                "raw_item_name": raw_item,
                "quantity": quantity if quantity is not None else Decimal("0.00"),
                "item_gross": item_gross,
            }
        )

    if not records:
        raise MenuSalesParseError("No item rows found in LINE MAN menu-sales sheet.")

    return records