"""Money — the single source of truth for currency in Replyo.

Every persona prices in Indian rupees today. That is a product decision, not a schema
limitation, and it lives here so the decision is visible in one file instead of being
re-implemented in the extractor, the admin API, the prompt builder and the console.

Two consequences worth spelling out:

  * `normalize_currency` funnels EVERY currency token to `DEFAULT_CURRENCY` — including
    foreign ones the extractor lifts verbatim off a page ("USD", "$", "AED", "€").
    That is deliberate: in a single-currency product an amount is an amount in rupees,
    and letting "USD" ride along on a row would make the catalog block quote a price
    the business does not charge (and the DB CHECK reject the write). It is a lossy,
    one-way funnel by design. Blank/None/non-string still returns None, so "the source
    stated no currency" stays distinguishable from "rupees".
  * `format_amount` groups digits the Indian way (1,50,000 — last three, then pairs)
    and does the grouping explicitly rather than through `locale`, which needs system
    locales installed and is process-global (so a library can't safely set it).

Adding a second currency later is a one-row change to `CURRENCIES` here plus a
migration relaxing the `catalog_items` currency CHECK — no caller has to change, they
all validate against `CURRENCY_CODES` and format through `format_amount`.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

# The supported set, in display order. `label` is what a picker shows; the console and
# the API both read the codes from here so they can never drift apart.
CURRENCIES: tuple[dict[str, str], ...] = (
    {"code": "INR", "symbol": "₹", "label": "Indian Rupee (₹)"},
)

DEFAULT_CURRENCY = "INR"
CURRENCY_CODES = frozenset(c["code"] for c in CURRENCIES)
_SYMBOLS = {c["code"]: c["symbol"] for c in CURRENCIES}


def normalize_currency(raw: object) -> str | None:
    """The stored currency code for whatever the extractor (or an owner) wrote.

    Recognises the rupee spellings ("INR", "inr", "₹", "Rs", "rs.", "rupee", "rupees")
    AND every foreign code/symbol ("USD", "$", "AED", "€") — all of them answer
    DEFAULT_CURRENCY while Replyo is single-currency (see the module docstring; the
    foreign mapping is deliberate, not a bug).

    None for None, a blank/whitespace string, or anything that isn't a string — those
    mean "no currency was stated", which is a real and different answer from rupees.
    """
    if not isinstance(raw, str):
        return None
    if not raw.strip():
        return None
    return DEFAULT_CURRENCY


def _group_indian(digits: str) -> str:
    """'150000' -> '1,50,000': last three digits, then pairs (the Indian convention)."""
    if len(digits) <= 3:
        return digits
    head, tail = digits[:-3], digits[-3:]
    groups: list[str] = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    return ",".join([*groups, tail])


def format_amount(amount: float | Decimal | int, currency: str | None = None) -> str:
    """A display price: '₹1,500', '₹1,50,000', '₹99.50'.

    No decimals when the amount is integral, exactly two otherwise — a price sheet
    reading "₹1,500.00" is noise, and one reading "₹99.5" looks like a typo. `currency`
    is normalized (so an un-migrated "USD" row still renders in rupees) and falls back
    to DEFAULT_CURRENCY.
    """
    code = normalize_currency(currency) or DEFAULT_CURRENCY
    symbol = _SYMBOLS.get(code, "")
    try:
        # str() first: Decimal(0.1) is 0.1000000000000000055511151231257827, Decimal("0.1") isn't.
        value = Decimal(str(amount))
    except (InvalidOperation, ValueError, TypeError):
        return f"{symbol}{amount}"
    sign = "-" if value < 0 else ""
    whole, _, cents = f"{abs(value).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP):f}".partition(".")
    text = _group_indian(whole)
    if cents and cents != "00":
        text += f".{cents}"
    return f"{sign}{symbol}{text}"
