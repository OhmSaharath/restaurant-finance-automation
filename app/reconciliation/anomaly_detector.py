from decimal import Decimal
from typing import Any, Dict, List, Optional

from schemas.cogs_models import AnomalyAlertModel


def detect_settlement_anomalies(
    gross_sales: Decimal,
    deductions: Decimal,
    net_sale: Decimal,
    details: Optional[Dict[str, Any]] = None,
    gp_threshold_pct: Decimal = Decimal("35.00"),
    ads_threshold_pct: Decimal = Decimal("20.00")
) -> List[AnomalyAlertModel]:
    """
    Evaluate daily delivery reports for potential financial anomalies, excessive deductions,
    or negative settlement balances.
    """
    anomalies: List[AnomalyAlertModel] = []
    details_data = details or {}

    # 1. Check for Negative Net Payout
    if net_sale < Decimal("0.00"):
        anomalies.append(
            AnomalyAlertModel(
                rule="NEGATIVE_NET_PAYOUT",
                severity="CRITICAL",
                message=f"Net delivery settlement payout is negative ({net_sale} THB). Deductions exceeded total sales.",
                metric_value=net_sale,
                threshold_value=Decimal("0.00"),
                metadata={"gross_sales": str(gross_sales), "deductions": str(deductions)}
            )
        )

    # 2. Check for Mathematical Discrepancy (net_sale != gross_sales - deductions)
    expected_net = gross_sales - deductions
    diff = abs(expected_net - net_sale)
    if diff > Decimal("0.05"):
        anomalies.append(
            AnomalyAlertModel(
                rule="SETTLEMENT_MATH_MISMATCH",
                severity="HIGH",
                message=f"Reported net_sale ({net_sale}) differs from (gross_sales - deductions = {expected_net}) by {diff} THB.",
                metric_value=diff,
                threshold_value=Decimal("0.05"),
                metadata={
                    "gross_sales": str(gross_sales),
                    "deductions": str(deductions),
                    "reported_net": str(net_sale),
                    "expected_net": str(expected_net)
                }
            )
        )

    # 3. Check for Excessive Total Deductions / GP Fee Ratio
    if gross_sales > Decimal("0.00"):
        deduction_pct = ((deductions / gross_sales) * Decimal("100.00")).quantize(Decimal("0.01"))
        if deduction_pct > gp_threshold_pct:
            anomalies.append(
                AnomalyAlertModel(
                    rule="EXCESSIVE_PLATFORM_DEDUCTIONS",
                    severity="HIGH",
                    message=f"Platform deductions represent {deduction_pct}% of gross sales, exceeding the {gp_threshold_pct}% threshold.",
                    metric_value=deduction_pct,
                    threshold_value=gp_threshold_pct,
                    metadata={"gross_sales": str(gross_sales), "deductions": str(deductions)}
                )
            )

    # 4. Check for High Marketing / Campaign / Ad Deductions in details
    marketing_val = Decimal("0.00")
    for key in ["promo_deductions", "campaign_discount", "ads", "marketing", "ad_fees"]:
        if key in details_data and details_data[key]:
            try:
                marketing_val += Decimal(str(details_data[key]))
            except Exception:
                pass

    if gross_sales > Decimal("0.00") and marketing_val > Decimal("0.00"):
        ads_pct = ((marketing_val / gross_sales) * Decimal("100.00")).quantize(Decimal("0.01"))
        if ads_pct > ads_threshold_pct:
            anomalies.append(
                AnomalyAlertModel(
                    rule="EXCESSIVE_AD_OR_CAMPAIGN_SPEND",
                    severity="MEDIUM",
                    message=f"Merchant campaign and ad deductions represent {ads_pct}% of gross sales, exceeding the {ads_threshold_pct}% warning limit.",
                    metric_value=ads_pct,
                    threshold_value=ads_threshold_pct,
                    metadata={"gross_sales": str(gross_sales), "ad_spend": str(marketing_val)}
                )
            )

    return anomalies
