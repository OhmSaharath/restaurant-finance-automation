from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Dict, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# -----------------------------------------------------------------------------
# Enums
# -----------------------------------------------------------------------------
class PlatformEnum(StrEnum):
    GRAB = "Grab"
    LINE_MAN = "LINE MAN"
    SHOPEE_FOOD = "Shopee Food"
    ROBINHOOD = "Robinhood"
    LOYVERSE_INSTORE = "LOYVERSE_INSTORE"


class BrandUserRoleEnum(StrEnum):
    OWNER = "owner"
    ADMIN = "admin"
    MANAGER = "manager"
    ACCOUNTANT = "accountant"


# -----------------------------------------------------------------------------
# 1. Brand Schemas
# -----------------------------------------------------------------------------
class BrandBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255, description="Brand display name")
    tax_id: Optional[str] = Field(None, max_length=50, description="Tax identification number")


class BrandCreate(BrandBase):
    pass


class BrandRead(BrandBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


class Brand(BrandRead):
    """Full Brand domain model."""
    pass


# -----------------------------------------------------------------------------
# 2. Branch Schemas
# -----------------------------------------------------------------------------
class BranchBase(BaseModel):
    brand_id: UUID = Field(..., description="Parent brand UUID")
    branch_code: str = Field(..., min_length=1, max_length=100, description="Unique branch code per brand")
    branch_name: str = Field(..., min_length=1, max_length=255, description="Human-readable branch name")
    address: Optional[str] = Field(None, description="Physical branch address")
    is_active: bool = Field(default=True, description="Active status flag")


class BranchCreate(BranchBase):
    pass


class BranchRead(BranchBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


class Branch(BranchRead):
    """Full Branch domain model."""
    pass


# -----------------------------------------------------------------------------
# 3. Brand User (RBAC) Schemas
# -----------------------------------------------------------------------------
class BrandUserBase(BaseModel):
    user_id: UUID = Field(..., description="Supabase auth.users UUID")
    brand_id: UUID = Field(..., description="Brand UUID")
    role: BrandUserRoleEnum = Field(..., description="Assigned role in tenant brand")


class BrandUserCreate(BrandUserBase):
    pass


class BrandUserRead(BrandUserBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


class BrandUser(BrandUserRead):
    """Full Brand User domain model."""
    pass


# -----------------------------------------------------------------------------
# 4. Branch Platform Mapping Schemas
# -----------------------------------------------------------------------------
class BranchPlatformMappingBase(BaseModel):
    branch_id: UUID = Field(..., description="Target branch UUID")
    platform: PlatformEnum = Field(..., description="Delivery platform name")
    raw_shop_name: str = Field(..., min_length=1, max_length=255, description="Exact platform shop name")


class BranchPlatformMappingCreate(BranchPlatformMappingBase):
    pass


class BranchPlatformMappingRead(BranchPlatformMappingBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


class BranchPlatformMapping(BranchPlatformMappingRead):
    """Full Branch Platform Mapping domain model."""
    pass


# Alias for concise naming requirements
BranchMapping = BranchPlatformMapping
BranchMappingBase = BranchPlatformMappingBase
BranchMappingCreate = BranchPlatformMappingCreate
BranchMappingRead = BranchPlatformMappingRead


# -----------------------------------------------------------------------------
# 5. Daily Report Schemas
# -----------------------------------------------------------------------------
class DailyReportBase(BaseModel):
    branch_id: Optional[UUID] = Field(None, description="Branch location UUID")
    platform: PlatformEnum = Field(..., description="Delivery platform name")
    report_date: date = Field(..., description="Report settlement date")
    shop_name_raw: Optional[str] = Field(None, max_length=255, description="Raw shop name from report")
    order_count: int = Field(default=0, ge=0, description="Total completed orders (>= 0)")
    gross_sales: Decimal = Field(
        default=Decimal("0.00"),
        ge=Decimal("0.00"),
        decimal_places=2,
        max_digits=12,
        description="Gross sales amount in THB (>= 0)"
    )
    deductions: Decimal = Field(
        default=Decimal("0.00"),
        decimal_places=2,
        max_digits=12,
        description="Commissions and deductions in THB"
    )
    net_sale: Decimal = Field(
        default=Decimal("0.00"),
        decimal_places=2,
        max_digits=12,
        description="Net payout amount in THB"
    )
    details: Dict[str, Any] = Field(
        default_factory=dict,
        description="Raw platform settlement payload and metadata"
    )

    @field_validator("gross_sales", "deductions", "net_sale", mode="before")
    @classmethod
    def convert_to_decimal(cls, v: Any) -> Decimal:
        if isinstance(v, (int, float, str)):
            return Decimal(str(v)).quantize(Decimal("0.01"))
        if isinstance(v, Decimal):
            return v.quantize(Decimal("0.01"))
        return v


class DailyReportCreate(DailyReportBase):
    pass


class DailyReportUpsert(BaseModel):
    branch_id: UUID = Field(..., description="Branch location UUID")
    platform: PlatformEnum = Field(..., description="Delivery platform name")
    report_date: date = Field(..., description="Report settlement date")
    shop_name_raw: Optional[str] = Field(None, max_length=255, description="Raw shop name from report")
    order_count: int = Field(default=0, ge=0, description="Total completed orders (>= 0)")
    gross_sales: Decimal = Field(
        default=Decimal("0.00"),
        ge=Decimal("0.00"),
        decimal_places=2,
        max_digits=12,
        description="Gross sales amount in THB (>= 0)"
    )
    deductions: Decimal = Field(
        default=Decimal("0.00"),
        decimal_places=2,
        max_digits=12,
        description="Commissions and deductions in THB"
    )
    net_sale: Decimal = Field(
        default=Decimal("0.00"),
        decimal_places=2,
        max_digits=12,
        description="Net payout amount in THB"
    )
    details: Dict[str, Any] = Field(
        default_factory=dict,
        description="Raw platform settlement payload and metadata"
    )

    @field_validator("gross_sales", "deductions", "net_sale", mode="before")
    @classmethod
    def convert_to_decimal(cls, v: Any) -> Decimal:
        if isinstance(v, (int, float, str)):
            return Decimal(str(v)).quantize(Decimal("0.01"))
        if isinstance(v, Decimal):
            return v.quantize(Decimal("0.01"))
        return v

    @model_validator(mode="after")
    def validate_non_negative_gross_sales(self) -> DailyReportUpsert:
        if self.gross_sales < Decimal("0.00"):
            raise ValueError("gross_sales cannot be negative")
        if self.order_count < 0:
            raise ValueError("order_count cannot be negative")
        return self


class DailyReportRead(DailyReportBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    branch_id: UUID
    created_at: datetime
    updated_at: datetime


class DailyReport(DailyReportRead):
    """Full Daily Report domain model."""
    pass


# -----------------------------------------------------------------------------
# Google Gmail Pub/Sub push notification schemas
# -----------------------------------------------------------------------------

class PubSubMessage(BaseModel):
    """One Cloud Pub/Sub push message (the wire envelope Google POSTs).

    Only ``data`` (base64 payload) and ``messageId`` are required; every other
    Google field (publishTime, attributes, ...) is ignored via extra="ignore"
    so a valid Google push never 422s on unknown fields.
    """
    model_config = ConfigDict(extra="ignore")

    data: str = Field(..., description="Base64-encoded Pub/Sub message payload (the Gmail history notification)")
    messageId: str = Field(..., description="Cloud Pub/Sub message id")


class PubSubPushNotification(BaseModel):
    """Top-level Pub/Sub push notification delivered to the webhook URL."""

    model_config = ConfigDict(extra="ignore")

    message: PubSubMessage = Field(..., description="The Pub/Sub message envelope")
    subscription: Optional[str] = Field(None, description="Subscription id (ignored for processing)")


class GmailHistoryNotification(BaseModel):
    """DECODED Gmail push payload (the JSON inside Pub/Sub message.data).

    Validated AFTER base64-decoding the envelope. Both fields are required and
    must be non-empty; a push missing either is malformed and rejected.
    """

    model_config = ConfigDict(extra="ignore")

    emailAddress: str = Field(..., min_length=1, description="Gmail address whose history changed (tenant isolation key)")
    # Gmail pushes historyId as a JSON NUMBER (unsigned long), NOT a string — the
    # watch() result and every push notification carry it as an integer. Declaring
    # it str caused real pushes to 422. Downstream list_history() already str()-coerces.
    historyId: int = Field(..., ge=0, description="Gmail history id (unsigned long) marking where the push starts")

    @model_validator(mode="after")
    def _reject_blank(self) -> GmailHistoryNotification:
        if not self.emailAddress.strip():
            raise ValueError("emailAddress must not be empty")
        return self
