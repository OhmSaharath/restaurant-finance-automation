import csv
import io
from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Optional

from app.ingestion.base import (
    BaseSettlementParser,
    SettlementParsingError,
    parse_date,
    to_decimal,
)
from schemas.models import PlatformEnum


class RobinhoodParser(BaseSettlementParser):
    """
    Parser for Robinhood daily merchant delivery reports (CSV).
    """

    platform = PlatformEnum.ROBINHOOD

    def parse(
        self,
        content: bytes | str,
        filename: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        text = content.decode("utf-8-sig", errors="replace") if isinstance(content, bytes) else content
        reader = csv.reader(io.StringIO(text))
        rows = [row for row in reader if any(field.strip() for field in row)]

        if not rows:
            raise SettlementParsingError("Robinhood settlement file is empty.")

        header_idx = -1
        for i, row in enumerate(rows[:20]):
            row_str = " ".join(c.lower() for c in row)
            if any(k in row_str for k in ["date", "shop", "order", "robinhood", "payout", "gross"]):
                header_idx = i
                break

        if header_idx == -1:
            raise SettlementParsingError("Unable to locate CSV header row in Robinhood file.")

        headers = [h.strip() for h in rows[header_idx]]
        data_rows = rows[header_idx + 1 :]

        col_map = self._map_columns(headers)
        aggregated: Dict[tuple, Dict[str, Any]] = defaultdict(lambda: {
            "order_count": 0,
            "gross_sales": Decimal("0.00"),
            "deductions": Decimal("0.00"),
            "net_sale": Decimal("0.00"),
        })

        for row in data_rows:
            if not any(row):
                continue
            raw_date = self._get_val(row, col_map.get("date"))
            raw_shop = self._get_val(row, col_map.get("shop_name"))

            if not raw_date or not raw_shop:
                continue

            report_date = parse_date(raw_date)
            shop_name_raw = raw_shop.strip()

            order_cnt = int(to_decimal(self._get_val(row, col_map.get("order_count")), Decimal("1")))
            gross = to_decimal(self._get_val(row, col_map.get("gross_sales")))
            deductions = to_decimal(self._get_val(row, col_map.get("deductions")))
            net_raw = self._get_val(row, col_map.get("net_sale"))

            if net_raw:
                net = to_decimal(net_raw)
            else:
                net = gross - deductions

            key = (shop_name_raw, report_date)
            agg = aggregated[key]
            agg["order_count"] += order_cnt
            agg["gross_sales"] += gross
            agg["deductions"] += deductions
            agg["net_sale"] += net

        results = []
        for (shop_name_raw, report_date), agg in aggregated.items():
            gross_final = agg["gross_sales"].quantize(Decimal("0.01"))
            deductions_final = agg["deductions"].quantize(Decimal("0.01"))
            net_final = agg["net_sale"].quantize(Decimal("0.01"))

            if not self.validate_financial_consistency(gross_final, deductions_final, net_final):
                net_final = (gross_final - deductions_final).quantize(Decimal("0.01"))

            results.append({
                "platform": PlatformEnum.ROBINHOOD,
                "report_date": report_date,
                "shop_name_raw": shop_name_raw,
                "order_count": max(0, agg["order_count"]),
                "gross_sales": gross_final,
                "deductions": deductions_final,
                "net_sale": net_final,
                "details": {
                    "source_platform": "Robinhood",
                    "filename": filename
                }
            })

        return results

    def _map_columns(self, headers: List[str]) -> Dict[str, int]:
        mapping = {}
        for idx, h in enumerate(headers):
            clean = h.lower().replace("_", " ").replace("-", " ")
            if any(k in clean for k in ["date", "วันที่", "settlement date"]):
                mapping.setdefault("date", idx)
            elif any(k in clean for k in ["shop", "store", "ชื่อร้าน", "partner"]):
                mapping.setdefault("shop_name", idx)
            elif any(k in clean for k in ["order count", "orders", "total orders"]):
                mapping.setdefault("order_count", idx)
            elif any(k in clean for k in ["gross sales", "total sales", "food subtotal", "gross"]):
                mapping.setdefault("gross_sales", idx)
            elif any(k in clean for k in ["deductions", "commission", "total fees"]):
                mapping.setdefault("deductions", idx)
            elif any(k in clean for k in ["net payout", "net amount", "payout", "net"]):
                mapping.setdefault("net_sale", idx)
        return mapping

    def _get_val(self, row: List[str], idx: Optional[int]) -> Optional[str]:
        if idx is not None and 0 <= idx < len(row):
            return row[idx].strip()
        return None
