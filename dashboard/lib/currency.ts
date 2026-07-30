// Money — one formatter and one currency list, so every price in the console reads the
// same way and adding a currency later is a data change rather than a UI change.
//
// INR is the only currency Replyo supports today: the backend rejects anything else, so
// writes always pin `currency: "INR"` alongside a numeric amount.

export type Currency = { code: string; symbol: string; label: string };

export const CURRENCIES: readonly Currency[] = [
  { code: "INR", symbol: "₹", label: "Indian Rupee (₹)" },
];

export const DEFAULT_CURRENCY = "INR";

/** "₹1,500" · "₹1,50,000" · "₹99.50" — Indian digit grouping, with decimals only when
 *  the amount actually has them. A code we don't know (a hand-edited or pre-INR row)
 *  renders as itself rather than being silently relabelled as rupees. */
export function formatPrice(amount: number, currency?: string | null): string {
  if (!Number.isFinite(amount)) return "";
  const digits = Number.isInteger(amount) ? 0 : 2;
  const opts: Intl.NumberFormatOptions = {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  };
  const code = (currency || DEFAULT_CURRENCY).trim().toUpperCase();
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: code, ...opts }).format(
      amount,
    );
  } catch {
    // Not a valid ISO-4217 code — fall back to a bare, still Indian-grouped number.
    return new Intl.NumberFormat("en-IN", opts).format(amount);
  }
}
