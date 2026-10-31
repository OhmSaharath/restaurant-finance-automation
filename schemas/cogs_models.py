from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


# -----------------------------------------------------------------------------
# 1. Master Ingredients Schemas
# -----------------------------------------------------------------------------
class IngredientBase(BaseModel):
    brand_id: UUID = Field(..., description="Parent brand UUID")
    name: str = Field(..., min_length=1, max_length=255, description="Ingredient name")
    uom: str = Field(..., min_length=1, max_length=50, description="Unit of Measure (e.g., g, ml, piece)")
    cost_per_unit: Decimal = Field(
        default=Decimal("0.0000"),
        ge=Decimal("0.0000"),
        decimal_places=4,
        max_digits=12,
        description="Unit cost in THB (NUMERIC 12,4)"
    )

    @field_validator("cost_per_unit", mode="before")
    @classmethod
    def convert_cost(cls, v: Any) -> Decimal:
        if isinstance(v, (int, float, str)):
            return Decimal(str(v)).quantize(Decimal("0.0001"))
        if isinstance(v, Decimal):
            return v.quantize(Decimal("0.0001"))
        return v


class IngredientCreate(IngredientBase):
    pass


class IngredientRead(IngredientBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


class Ingredient(IngredientRead):
    """Domain model for master ingredient."""
    pass


# -----------------------------------------------------------------------------
# 2. Menu Items Schemas
# -----------------------------------------------------------------------------
class MenuItemBase(BaseModel):
    brand_id: UUID = Field(..., description="Parent brand UUID")
    menu_code: str = Field(..., min_length=1, max_length=100, description="Internal unique menu code")
    name: str = Field(..., min_length=1, max_length=255, description="Menu item display name")
    selling_price: Decimal = Field(
        default=Decimal("0.00"),
        ge=Decimal("0.00"),
        decimal_places=2,
        max_digits=12,
        description="Selling price in THB (NUMERIC 12,2)"
    )
    is_active: bool = Field(default=True, description="Active status flag")

    @field_validator("selling_price", mode="before")
    @classmethod
    def convert_price(cls, v: Any) -> Decimal:
        if isinstance(v, (int, float, str)):
            return Decimal(str(v)).quantize(Decimal("0.01"))
        if isinstance(v, Decimal):
            return v.quantize(Decimal("0.01"))
        return v


class MenuItemCreate(MenuItemBase):
    pass


class MenuItemRead(MenuItemBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


class MenuItem(MenuItemRead):
    """Domain model for menu item."""
    pass


# -----------------------------------------------------------------------------
# 3. Recipe Bill of Materials (BOM) Schemas
# -----------------------------------------------------------------------------
class RecipeBOMBase(BaseModel):
    menu_item_id: UUID = Field(..., description="Parent menu item UUID")
    ingredient_id: UUID = Field(..., description="Required ingredient UUID")
    quantity: Decimal = Field(
        ...,
        gt=Decimal("0.0000"),
        decimal_places=4,
        max_digits=12,
        description="Required quantity per menu serving (NUMERIC 12,4)"
    )

    @field_validator("quantity", mode="before")
    @classmethod
    def convert_quantity(cls, v: Any) -> Decimal:
        if isinstance(v, (int, float, str)):
            return Decimal(str(v)).quantize(Decimal("0.0001"))
        if isinstance(v, Decimal):
            return v.quantize(Decimal("0.0001"))
        return v


class RecipeBOMCreate(RecipeBOMBase):
    pass


class RecipeBOMRead(RecipeBOMBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


class RecipeBOM(RecipeBOMRead):
    """Domain model for Recipe BOM."""
    pass


# -----------------------------------------------------------------------------
# 4. Financial Analytics & P&L Schemas
# -----------------------------------------------------------------------------
class AnomalyAlertModel(BaseModel):
    rule: str = Field(..., description="Anomaly rule identifier")
    severity: str = Field(..., description="Alert severity: LOW, MEDIUM, HIGH, CRITICAL")
    message: str = Field(..., description="Detailed description of the anomaly")
    metric_value: Decimal = Field(..., description="Observed metric value")
    threshold_value: Decimal = Field(..., description="Expected or maximum threshold value")
    metadata: Dict[str, Any] = Field(default_factory=dict)


class BranchPNLSummary(BaseModel):
    branch_id: UUID
    branch_name: Optional[str] = None
    order_count: int = 0
    gross_sales: Decimal = Field(default=Decimal("0.00"), decimal_places=2)
    deductions: Decimal = Field(default=Decimal("0.00"), decimal_places=2)
    net_sale: Decimal = Field(default=Decimal("0.00"), decimal_places=2)
    total_cogs: Decimal = Field(default=Decimal("0.00"), decimal_places=2)
    real_net_profit: Decimal = Field(default=Decimal("0.00"), decimal_places=2)
    net_margin_pct: Decimal = Field(default=Decimal("0.00"), decimal_places=2)
    gp_deduction_pct: Decimal = Field(default=Decimal("0.00"), decimal_places=2)


class FinancialSummaryResponse(BaseModel):
    start_date: date
    end_date: date
    brand_id: Optional[UUID] = None
    total_branches: int = 0
    total_orders: int = 0
    gross_sales: Decimal = Field(default=Decimal("0.00"), decimal_places=2, description="Total gross sales in THB")
    deductions: Decimal = Field(default=Decimal("0.00"), decimal_places=2, description="Total platform deductions in THB")
    net_sale: Decimal = Field(default=Decimal("0.00"), decimal_places=2, description="Net platform payout in THB")
    total_cogs: Decimal = Field(default=Decimal("0.00"), decimal_places=2, description="Total estimated Cost of Goods Sold in THB")
    other_expenses: Decimal = Field(default=Decimal("0.00"), decimal_places=2, description="Other branch operating expenses in THB")
    real_net_profit: Decimal = Field(default=Decimal("0.00"), decimal_places=2, description="Real Net Profit: net_sale - cogs - other_expenses")
    net_margin_pct: Decimal = Field(default=Decimal("0.00"), decimal_places=2, description="Net margin as percentage of gross sales")
    branches_summary: List[BranchPNLSummary] = Field(default_factory=list)
    anomalies: List[AnomalyAlertModel] = Field(default_factory=list)
