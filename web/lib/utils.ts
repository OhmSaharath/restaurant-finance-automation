import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTHB(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return "—";
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency: "THB",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

export function formatPercent(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "0.00%";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "0.00%";
  return `${num.toFixed(2)}%`;
}

/* ================================================================== */

export interface ParsedPayments {
  ePayment: number;
  cash: number;
  campaigns: number;
  otherPayments: number;
}

export interface ParsedDeductions {
  gp: number; // GP commission / service fee
  ads: number; // listing ads / sponsored
  promos: number; // merchant promotions
  vat: number; // VAT 7%
  other: number; // unclassified residual fees
  total: number; // sum of every numeric deduction value found in JSONB
}

export interface ParsedFinancialDetails {
  payments: ParsedPayments;
  hasCash: boolean;
  deductions: ParsedDeductions;
  vatIncludedInGp: boolean; // Grab bundles VAT inside GP commission
  raw: any; // the parsed JSONB object for downstream debug / drawer display
}

/** Parse a numeric JSONB scalar. Returns 0 ONLY when the key is truly absent/null — positive values are never coerced to 0.00. */
export function toNum(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Platform-aware extraction from daily_reports.details (JSONB). The exact keys
 * are first-class (never fall back to 0.00 for positive raw values):
 *   LINE MAN: payment.{E-Payment, Cash}; deductions.{GP Fee (Before VAT),
 *     Listing Ads (Before VAT), Promotions & Marketing (Before VAT), VAT}
 *   Grab: payment.{Grab E-Payment, Thai Chuay Thai}; deductions.
 *     {Grab - ค่าคอมและภาษี, Grab - โฆษณา, Grab - โปรโมชันร้าน, ...}
 * Grab's VAT is bundled inside "ค่าคอมและภาษี" (commission AND tax), so we flag
 * vatIncludedInGp instead of fabricating a 0.00 VAT line.
 */
export function parseFinancialDetails(
  platform: string,
  details: any
): ParsedFinancialDetails {
  let parsed = details;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = {};
    }
  }
  const payment =
    parsed?.payment && typeof parsed.payment === "object" ? parsed.payment : {};
  const deductions =
    parsed?.deductions && typeof parsed.deductions === "object"
      ? parsed.deductions
      : {};

  const sumAll = () =>
    Object.values(deductions).reduce((sum: number, v: any) => sum + toNum(v), 0);

  if (platform === "Grab") {
    const gp = toNum(deductions["Grab - ค่าคอมและภาษี"]);
    const tct = toNum(payment["Thai-Chuay-Thai"]) + toNum(payment["Thai Chuay Thai"]);
    return {
      payments: {
        ePayment: toNum(payment["Grab E-Payment"]),
        cash: tct,
        campaigns: 0,
        otherPayments: 0,
      },
      hasCash: tct > 0,
      deductions: {
        gp,
        ads: toNum(deductions["Grab - โฆษณา"]),
        promos: toNum(deductions["Grab - โปรโมชันร้าน"]),
        vat: 0,
        other:
          toNum(deductions["Grab - ค่าธรรมเนียมการตลาด"]) +
          toNum(deductions["Grab - อื่นๆ"]),
        total: sumAll(),
      },
      vatIncludedInGp: true,
      raw: parsed,
    };
  }

  // LINE MAN (and any platform using the canonical LINE MAN keys)
  const ePayment = toNum(payment["E-Payment"]);
  const cash = toNum(payment["Cash"]);
  return {
    payments: {
      ePayment,
      cash,
      campaigns: toNum(payment["Campaigns"]) + toNum(payment["Subsidies"]),
      otherPayments: 0,
    },
    hasCash: cash > 0,
    deductions: {
      gp: toNum(deductions["GP Fee (Before VAT)"]),
      ads: toNum(deductions["Listing Ads (Before VAT)"]),
      promos: toNum(deductions["Promotions & Marketing (Before VAT)"]),
      vat: toNum(deductions["VAT"]),
      other: 0,
      total: sumAll(),
    },
    vatIncludedInGp: false,
    raw: parsed,
  };
}
