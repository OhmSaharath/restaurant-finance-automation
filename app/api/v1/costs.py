"""Menu-cost file import: scan-only preview endpoint (Phase 2).

POST /api/v1/costs/scan — upload a CSV / Excel menu-cost file and get a
STATELESS preview (detected columns + parsed rows). This endpoint NEVER writes
to the database: it only parses the uploaded file and returns the detection
preview. The client confirms the rows and performs the inserts through the
browser's Supabase RLS client (no service-role key, no hardcoded brand_id), so
tenant isolation is enforced by RLS at the write path and the scan endpoint
needs no DB access at all.

Security & guardrails:
  - Protected by ``get_authenticated_user`` (JWT) and slowapi rate limiting.
  - Money: cost is rounded to 2dp half-up (NUMERIC(12,2) contract); rows with no
    detectable cost carry ``cost: null`` (never a fabricated 0.00).
  - No secrets here: the API key is resolved env-first by app.core.config.

Thai column headers are matched with pure-A \\u escapes (this environment
mojibakes raw Thai literals through file edits):
  - name-ish: \\u0e0a\\u0e37\\u0e48\\u0e2d = \u0e0a\u0e37\u0e48\u0e2d  (name)
              \\u0e40\\u0e21\\u0e19\\u0e39 = \u0e40\u0e21\u0e19\u0e39  (menu)
              \\u0e23\\u0e32\\u0e22\\u0e01\\u0e32\\u0e23 = \u0e23\u0e32\u0e22\u0e01\u0e32\u0e23  (list)
  - cost-ish: \\u0e15\\u0e49\\u0e19\\u0e17\\u0e38\\u0e19 = \u0e15\u0e49\u0e19\u0e17\u0e38\u0e19  (cost)
              \\u0e23\\u0e32\\u0e04\\u0e32 = \u0e23\u0e32\u0e04\u0e32  (price)
"""
import io
import math
import re
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional

import pandas as pd
from pandas.errors import EmptyDataError
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.auth import get_authenticated_user
from app.core.rate_limit import limiter

router = APIRouter(prefix="/costs", tags=["Menu Cost Import"])

MAX_PREVIEW_ROWS = 500
SAMPLE_ROWS = 10

# --- Thai header keywords (pure-ASCII \\u escapes; see module docstring) ------
NAME_THAI_KEYWORDS = [
    "\u0e0a\u0e37\u0e48\u0e2d",  # \u0e0a\u0e37\u0e48\u0e2d = name
    "\u0e40\u0e21\u0e19\u0e39",  # \u0e40\u0e21\u0e19\u0e39 = menu
    "\u0e23\u0e32\u0e22\u0e01\u0e32\u0e23",  # \u0e23\u0e32\u0e22\u0e01\u0e32\u0e23 = list
]
COST_THAI_KEYWORDS = [
    "\u0e15\u0e49\u0e19\u0e17\u0e38\u0e19",  # \u0e15\u0e49\u0e19\u0e17\u0e38\u0e19 = cost
    "\u0e23\u0e32\u0e04\u0e32",  # \u0e23\u0e32\u0e04\u0e32 = price
]

NAME_PATTERN = re.compile(r"(name|menu|item|dish|product|title)")
COST_PATTERN = re.compile(r"(cost|price)")


# =============================================================================
# Pydantic response models
# =============================================================================
class CostRow(BaseModel):
    name: str
    cost: Optional[float] = None


class CostScanResponse(BaseModel):
    status: str = "ok"
    columns: List[str]
    name_column: Optional[str] = None
    cost_column: Optional[str] = None
    rows: List[CostRow] = Field(default_factory=list)
    row_count: int = 0
    needs_manual_mapping: bool = False
    sample_rows: List[Dict[str, Any]] = Field(default_factory=list)


# =============================================================================
# Parsing helpers
# =============================================================================
def _read_tabular(filename: str, content: bytes) -> pd.DataFrame:
    """Parse an uploaded file into a DataFrame, choosing the parser by extension.

    .xlsx / .xls -> pandas.read_excel (reusing the in-memory pattern from
    gmail_ingestion._to_csv_bytes). Anything else is treated as CSV: try
    ``utf-8-sig`` with the C engine first, then fall back to a permissive Python
    engine that tolerates ragged rows. An unparseable/empty file raises a 422.
    """
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    buf = io.BytesIO(content)

    if ext in ("xlsx", "xls"):
        try:
            df = pd.read_excel(buf)
        except Exception:
            # Not really an Excel file despite the extension — fall back to CSV.
            buf.seek(0)
            try:
                df = pd.read_csv(buf, engine="python", encoding="utf-8", on_bad_lines="skip")
            except Exception:
                return pd.DataFrame()

    if ext not in ("xlsx", "xls"):
        try:
            buf.seek(0)
            df = pd.read_csv(buf, encoding="utf-8-sig")
        except EmptyDataError:
            return pd.DataFrame()
        except Exception:
            buf.seek(0)
            try:
                df = pd.read_csv(buf, engine="python", encoding="utf-8", on_bad_lines="skip")
            except Exception:
                return pd.DataFrame()

    return df if df is not None else pd.DataFrame()


def _parse_number(value: Any) -> Optional[float]:
    """Parse a cell as a float; None for blanks, booleans, or malformed text."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        f = float(str(value).replace(",", "").strip())
    except (ValueError, TypeError):
        return None
    if not math.isfinite(f):
        return None
    return f


def _round2(value: Optional[float]) -> Optional[float]:
    """Round to 2dp half-up (NUMERIC(12,2) contract). None -> None."""
    if value is None:
        return None
    try:
        return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
    except Exception:
        return None


def _is_nullish(value: Any) -> bool:
    if value is None:
        return True
    try:
        f = float(value)
        if math.isnan(f):
            return True
    except (TypeError, ValueError):
        pass
    return isinstance(value, float) and str(value).strip() == ""


def _clean_name(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return str(value).strip()


def _is_numeric_col(df: pd.DataFrame, col: str) -> bool:
    vals = [v for v in df[col].tolist() if not _is_nullish(v)]
    if not vals:
        return False
    nums = sum(1 for v in vals if _parse_number(v) is not None)
    return nums / len(vals) >= 0.7


def _is_text_col(df: pd.DataFrame, col: str) -> bool:
    vals = [v for v in df[col].tolist() if not _is_nullish(v)]
    if not vals:
        return False
    texts = sum(1 for v in vals if _parse_number(v) is None)
    return texts / len(vals) >= 0.6


# =============================================================================
# Heuristic, deterministic column detection
# =============================================================================
def _detect_columns(df: pd.DataFrame, columns: List[str]) -> tuple[Optional[str], Optional[str]]:
    """Return (name_column, cost_column) or (None, ...) when undetectable.

    Order:
      1. NAME — first header whose lowercase form matches /name|menu|item|dish|
         product|title/ OR contains a Thai name keyword (name/menu/list). If no
         keyword header matches, fall back to the first column whose values are
         predominantly non-numeric text.
      2. COST — first header matching /cost|price/ OR a Thai cost/price keyword;
         else the first numeric column located after the name column. When no
         cost column is found and there is exactly one textual column, cost stays
         None (the user enters costs manually later).
    """
    norm = [str(c).strip().lower() for c in columns]

    def is_thai_name(h: str) -> bool:
        return any(k in h for k in NAME_THAI_KEYWORDS)

    def is_thai_cost(h: str) -> bool:
        return any(k in h for k in COST_THAI_KEYWORDS)

    name_col: Optional[str] = None
    for i, h in enumerate(norm):
        if NAME_PATTERN.search(h) or is_thai_name(h):
            name_col = columns[i]
            break

    if name_col is None:
        for i, h in enumerate(norm):
            if _is_text_col(df, columns[i]):
                name_col = columns[i]
                break

    cost_col: Optional[str] = None
    if name_col is not None:
        name_idx = columns.index(name_col)
        for i, h in enumerate(norm):
            if COST_PATTERN.search(h) or is_thai_cost(h):
                cost_col = columns[i]
                break
        if cost_col is None:
            for i in range(name_idx + 1, len(columns)):
                if _is_numeric_col(df, columns[i]):
                    cost_col = columns[i]
                    break

    return name_col, cost_col


# =============================================================================
# Endpoint
# =============================================================================
@router.post(
    "/scan",
    response_model=CostScanResponse,
    status_code=status.HTTP_200_OK,
    summary="Scan a menu-cost CSV/Excel file and return a preview",
    description="Stateless: parses the uploaded file and returns detected columns "
    "plus up to 500 parsed rows for the client to confirm before inserting. "
    "Never writes to the database.",
)
@limiter.limit(settings.RATE_LIMIT_PER_MINUTE)
async def scan_costs(
    request: Request,
    file: UploadFile = File(..., description="Menu-cost file (.csv/.xlsx/.xls)"),
    user_id: str = Depends(get_authenticated_user),
) -> CostScanResponse:
    content = await file.read()
    if not content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "EMPTY_FILE", "message": "Uploaded file is empty."},
        )

    filename = file.filename or ""
    try:
        df = _read_tabular(filename, content)
    except Exception as exc:  # noqa: BLE001 - normalized to a 422 below
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "PARSE_FAILED", "message": f"Could not parse '{filename}': {exc}"},
        )

    if df is None or df.empty:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "EMPTY_TABLE", "message": "File contains no tabular rows."},
        )

    columns = [str(c) for c in df.columns]
    if not columns:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "NO_COLUMNS", "message": "No columns detected in file."},
        )

    name_col, cost_col = _detect_columns(df, columns)

    rows: List[CostRow] = []
    if name_col is not None:
        for _, rec in df.iterrows():
            name = _clean_name(rec.get(name_col))
            if not name:
                continue  # skip rows with an empty name
            cost: Optional[float] = None
            if cost_col is not None:
                cost = _round2(_parse_number(rec.get(cost_col)))
            rows.append(CostRow(name=name, cost=cost))
            if len(rows) >= MAX_PREVIEW_ROWS:
                break

    # Raw first rows, always provided (used by the frontend for a "manual
    # mapping" preview when no name column could be detected).
    sample_rows: List[Dict[str, Any]] = []
    for _, rec in df.head(SAMPLE_ROWS).iterrows():
        sample_rows.append({h: (None if _is_nullish(rec[h]) else str(rec[h])) for h in columns})

    return CostScanResponse(
        status="ok",
        columns=columns,
        name_column=name_col,
        cost_column=cost_col,
        rows=rows,
        row_count=len(rows),
        needs_manual_mapping=name_col is None,
        sample_rows=sample_rows,
    )
