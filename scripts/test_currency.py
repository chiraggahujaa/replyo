"""Deterministic tests for money formatting and the product-image helpers.

Two small, purely-functional modules, tested together because both are the "no
side-effects" half of the catalog feature:

  app/currency.py  normalize_currency / format_amount — the single-currency funnel and
                   Indian digit grouping.
  app/storage.py   sniff_image_type / object_path / object_path_from_url — the magic-byte
                   check that decides what a public bucket will serve back, and the URL
                   parsing that decides whether a DELETE is ours to issue. Both are pure,
                   so this exercises the security-relevant logic with no network at all.

Run:  uv run python scripts/test_currency.py
"""

from __future__ import annotations

from decimal import Decimal

from app import storage
from app.currency import DEFAULT_CURRENCY, format_amount, normalize_currency

FAILURES = []


def check(name, ok, detail=""):
    print(("   PASS " if ok else "   FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)


# ---------------- 1) normalize_currency ----------------

def test_normalize_currency():
    print("\n\033[1m1) normalize_currency — everything stated becomes INR\033[0m")

    for raw in ("INR", "inr", "  Inr  ", "₹", "Rs", "rs.", "Rupees", "rupees"):
        check(f"rupee spelling {raw!r} -> INR", normalize_currency(raw) == "INR",
              str(normalize_currency(raw)))

    # Deliberate, documented coercion: Replyo is single-currency, so a foreign code the
    # extractor lifted off a page still means "the amount the business charges", i.e.
    # rupees. Letting "USD" ride along would quote a price nobody charges.
    for raw in ("USD", "$", "AED", "€", "EUR", "GBP"):
        check(f"foreign token {raw!r} is coerced to INR", normalize_currency(raw) == "INR",
              str(normalize_currency(raw)))

    check("INR is the default currency", DEFAULT_CURRENCY == "INR", DEFAULT_CURRENCY)

    # None means "the source stated no currency", which stays distinct from rupees.
    check("None -> None", normalize_currency(None) is None)
    check("'' -> None", normalize_currency("") is None)
    check("'   ' -> None", normalize_currency("   ") is None)
    check("a number -> None", normalize_currency(123) is None)
    check("a list -> None", normalize_currency([]) is None)
    check("a dict -> None", normalize_currency({"code": "INR"}) is None)


# ---------------- 2) format_amount ----------------

def test_format_amount():
    print("\n\033[1m2) format_amount — ₹ with Indian digit grouping\033[0m")

    check("1500 -> ₹1,500", format_amount(1500) == "₹1,500", format_amount(1500))
    check("150000 -> ₹1,50,000", format_amount(150000) == "₹1,50,000", format_amount(150000))
    check("10000000 groups the Indian way (₹1,00,00,000)",
          format_amount(10000000) == "₹1,00,00,000", format_amount(10000000))
    check("999 needs no separator", format_amount(999) == "₹999", format_amount(999))
    check("99.5 -> ₹99.50 (exactly two decimals)",
          format_amount(99.5) == "₹99.50", format_amount(99.5))
    check("0 -> ₹0", format_amount(0) == "₹0", format_amount(0))
    check("an integral float drops the decimals",
          format_amount(1500.0) == "₹1,500", format_amount(1500.0))
    check("Decimal input formats identically",
          format_amount(Decimal("1500.00")) == "₹1,500", format_amount(Decimal("1500.00")))
    check("a negative amount keeps the sign outside the symbol",
          format_amount(-1500) == "-₹1,500", format_amount(-1500))

    # The currency argument goes through the same funnel, so an un-migrated row still
    # renders in rupees rather than leaking a code the business does not charge.
    check("currency=None falls back to INR", format_amount(1500, None) == "₹1,500")
    check("currency='INR' is honoured", format_amount(1500, "INR") == "₹1,500")
    check("a legacy 'USD' row still renders in ₹",
          format_amount(1500, "USD") == "₹1,500", format_amount(1500, "USD"))


# ---------------- 3) sniff_image_type ----------------

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x00" * 16
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 16
WEBP = b"RIFF" + (128).to_bytes(4, "little") + b"WEBPVP8 " + b"\x00" * 16


def test_sniff_image_type():
    print("\n\033[1m3) sniff_image_type — the type comes from the bytes, never the client\033[0m")

    check("PNG magic bytes detected", storage.sniff_image_type(PNG) == "image/png",
          str(storage.sniff_image_type(PNG)))
    check("JPEG magic bytes detected", storage.sniff_image_type(JPEG) == "image/jpeg",
          str(storage.sniff_image_type(JPEG)))
    check("WEBP (RIFF....WEBP) detected", storage.sniff_image_type(WEBP) == "image/webp",
          str(storage.sniff_image_type(WEBP)))

    check("a text blob is rejected",
          storage.sniff_image_type(b"<html><script>alert(1)</script>") is None)
    check("an SVG is rejected (it would be active content on a public CDN)",
          storage.sniff_image_type(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>") is None)
    check("empty bytes are rejected", storage.sniff_image_type(b"") is None)
    check("a truncated PNG header is rejected", storage.sniff_image_type(b"\x89PNG") is None)
    check("a truncated JPEG header is rejected", storage.sniff_image_type(b"\xff\xd8") is None)
    check("RIFF without the WEBP tag is rejected (a .wav, say)",
          storage.sniff_image_type(b"RIFF" + b"\x00" * 4 + b"WAVEfmt ") is None)
    check("every sniffed type has an extension",
          all(t in storage.ALLOWED_IMAGE_TYPES for t in ("image/png", "image/jpeg", "image/webp")))


# ---------------- 4) object_path / object_path_from_url ----------------

def test_object_paths():
    print("\n\033[1m4) storage paths — only our own URLs can drive a DELETE\033[0m")

    # Pin the project URL so the prefix is deterministic whatever the local .env says.
    original = storage.settings.supabase_url
    storage.settings.supabase_url = "https://project.supabase.co"
    try:
        prefix = storage.public_url_prefix()
        check("public prefix is the bucket's public path",
              prefix == "https://project.supabase.co/storage/v1/object/public/catalog-images/",
              prefix)

        path = storage.object_path(tenant_id="tenant-1", item_id="item-2", ext="png")
        head, _, name = path.rpartition("/")
        check("path is '<tenant>/<item>/<random>.<ext>'",
              head == "tenant-1/item-2" and name.endswith(".png") and len(name) == len("x" * 32) + 4,
              path)
        check("two uploads for the same item get different keys",
              storage.object_path(tenant_id="t", item_id="i", ext="png")
              != storage.object_path(tenant_id="t", item_id="i", ext="png"))

        ours = f"{prefix}tenant-1/item-2/abc123.png"
        check("our own URL parses back to the object key",
              storage.object_path_from_url(ours) == "tenant-1/item-2/abc123.png",
              str(storage.object_path_from_url(ours)))

        # Anything not under our prefix must be unparseable: image_url is plain text, and
        # a hostile or hand-edited value must never become a DELETE somewhere else.
        for hostile in (
            "https://evil.example.com/storage/v1/object/public/catalog-images/x/y/z.png",
            "https://project.supabase.co/storage/v1/object/public/other-bucket/x.png",
            "http://project.supabase.co/storage/v1/object/public/catalog-images/x.png",  # scheme
            "https://project.supabase.co/storage/v1/object/catalog-images/x.png",  # not public
            "/storage/v1/object/public/catalog-images/x.png",  # relative
            "tenant-1/item-2/abc123.png",  # a bare key, not a URL of ours
            "",
            prefix,  # the prefix with no object after it
        ):
            check(f"foreign/unusable URL -> None: {hostile[:58]!r}",
                  storage.object_path_from_url(hostile) is None,
                  str(storage.object_path_from_url(hostile)))

        check("None -> None", storage.object_path_from_url(None) is None)
        check("a non-string -> None", storage.object_path_from_url(12345) is None)
    finally:
        storage.settings.supabase_url = original


def main():
    test_normalize_currency()
    test_format_amount()
    test_sniff_image_type()
    test_object_paths()
    print("\n" + "=" * 56)
    if FAILURES:
        print(f"  {len(FAILURES)} FAILURES: {FAILURES}")
        raise SystemExit(1)
    print("  ALL CURRENCY + STORAGE TESTS PASSED")
    print("=" * 56)


if __name__ == "__main__":
    main()
