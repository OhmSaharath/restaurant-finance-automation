from abc import ABC, abstractmethod
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional
import re

from schemas.models import DailyReportUpsert, PlatformEnum


class SettlementParsingError(Exception):
    """Raised when settlement file format or content is malformed."""
    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}


def to_decimal(value: Any, default: Decimal = Decimal("0.00")) -> Decimal:
    """Safely convert numeric/string inputs to Decimal with exact 2 decimal places."""
    if value is None:
        return default
    if isinstance(value, Decimal):
        return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    # Strip currency symbols, commas, and spaces
    clean_val = re.sub(r"[^\d.-]", "", str(value).strip())
    if not clean_val or clean_val in ("-", "."):
        return default

    try:
        return Decimal(clean_val).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except Exception:
        return default


def parse_date(value: Any) -> date:
    """
    Safely parse various date string formats, handling both CE (2026) and Thai BE (2569) years.
    """
    if isinstance(value, date):
        return value
    if isinstance(value, datetime):
        return value.date()

    s = str(value).strip()
    # Normalize common separators
    s = re.sub(r"[/.]", "-", s)

    # Patterns to match
    patterns = [
        r"^(\d{4})-(\d{1,2})-(\d{1,2})$",       # YYYY-MM-DD
        r"^(\d{1,2})-(\d{1,2})-(\d{4})$",       # DD-MM-YYYY
        r"^(\d{1,2})-(\d{1,2})-(\d{2})$",         # DD-MM-YY
    ]

    for pat in patterns:
        m = re.match(pat, s)
        if m:
            raw_parts = m.groups()
            parts = [int(p) for p in raw_parts]
            if len(raw_parts[0]) == 4 or parts[0] > 100:  # YYYY-MM-DD
                year, month, day = parts[0], parts[1], parts[2]
            else:  # DD-MM-YYYY
                day, month, year = parts[0], parts[1], parts[2]
                if year < 100:
                    year += 2000

            # Handle Thai Buddhist Era (BE) year conversion: e.g. 2569 -> 2026
            if year > 2400:
                year -= 543

            return date(year, month, day)

    # Fallback to dateutil or ISO format
    try:
        dt = datetime.fromisoformat(s)
        year = dt.year - 543 if dt.year > 2400 else dt.year
        return date(year, dt.month, dt.day)
    except Exception as e:
        raise SettlementParsingError(f"Unable to parse date string: '{value}'", {"raw_value": str(value)})


class BaseSettlementParser(ABC):
    """Abstract Base Class for Platform Settlement Parsers."""

    platform: PlatformEnum

    @abstractmethod
    def parse(
        self,
        content: bytes | str,
        filename: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Parse raw settlement file content into a list of normalized daily report dictionaries.
        """
        pass

    def validate_financial_consistency(
        self,
        gross_sales: Decimal,
        deductions: Decimal,
        net_sale: Decimal,
        tolerance: Decimal = Decimal("0.05")
    ) -> bool:
        """
        Verify: net_sale == gross_sales - deductions (within optional rounding tolerance).
        """
        expected_net = gross_sales - deductions
        diff = abs(expected_net - net_sale)
        return diff <= tolerance
