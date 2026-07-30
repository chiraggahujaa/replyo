"""Deterministic tests for the business-catalog pipeline's pure pieces.

Covers `_merge` (dedupe + coalesce rules in app/extraction.py) and the prompt-block
builders in app/catalog.py, plus the admin API request-model validation. All pure —
no network, no database, no LLM.

Run:  uv run python scripts/test_catalog.py
"""

from __future__ import annotations

from app.catalog import build_catalog_block, build_guidelines_block
from app.extraction import ExtractedItem, ExtractedSnippet, ExtractionBatch, _merge

FAILURES = []


def check(name, ok, detail=""):
    print(("   PASS " if ok else "   FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)


def _batch(items=(), snippets=()):
    return ExtractionBatch(items=list(items), snippets=list(snippets))


def test_merge_items():
    print("\n\033[1m1) _merge — item dedupe\033[0m")

    poor = ExtractedItem(kind="service", name="Teeth Cleaning", price_text="AED 300")
    rich = ExtractedItem(
        kind="service", name="  teeth   CLEANING ", description="Scale and polish",
        price_amount=300.0, currency="AED",
    )
    items, _ = _merge([(_batch([poor]), "pricelist.md"), (_batch([rich]), "https://x.com/services")])
    check("same name, different case/whitespace -> one item", len(items) == 1, str(len(items)))
    it = items[0]
    check("richer candidate wins (its description kept)", it["description"] == "Scale and polish")
    check("winner's batch source attached", it["source"] == "https://x.com/services", str(it["source"]))
    check("field coalesce: winner's gap filled from loser (price_text)",
          it["price_text"] == "AED 300", str(it["price_text"]))
    check("winner's own fields survive the coalesce",
          it["price_amount"] == 300.0 and it["currency"] == "AED")

    a = ExtractedItem(kind="product", name="Whitening Kit", price_text="AED 250")
    b = ExtractedItem(kind="product", name="whitening kit", category="Retail")
    items, _ = _merge([(_batch([a]), "s1"), (_batch([b]), "s2")])
    check("richness tie -> first candidate wins (name + source)",
          items[0]["name"] == "Whitening Kit" and items[0]["source"] == "s1",
          f"{items[0]['name']!r} / {items[0]['source']!r}")
    check("tie still coalesces the loser's extra field", items[0]["category"] == "Retail")

    svc = ExtractedItem(kind="service", name="Whitening")
    prod = ExtractedItem(kind="product", name="Whitening")
    items, _ = _merge([(_batch([svc, prod]), None)])
    check("same name, different kind -> NOT merged", len(items) == 2, str(len(items)))

    blank = ExtractedItem(kind="service", name="   ")
    items, _ = _merge([(_batch([blank]), None)])
    check("blank-named item is dropped", items == [], str(items))


def test_merge_snippets():
    print("\n\033[1m2) _merge — snippet dedupe\033[0m")

    short = ExtractedSnippet(kind="guideline", title="Cancellation Policy", body="24h notice.")
    long = ExtractedSnippet(
        kind="guideline", title="cancellation   policy",
        body="Cancel at least 24 hours ahead or a fee applies.",
    )
    _, snippets = _merge([(_batch(snippets=[short]), "a.md"), (_batch(snippets=[long]), "b.md")])
    check("title dedupe is case/whitespace-insensitive", len(snippets) == 1, str(len(snippets)))
    check("longer body wins", snippets[0]["body"].startswith("Cancel at least"))
    check("winner's source kept", snippets[0]["source"] == "b.md", str(snippets[0]["source"]))

    _, snippets = _merge([(_batch(snippets=[long]), "b.md"), (_batch(snippets=[short]), "a.md")])
    check("order-independent: longer body still wins", snippets[0]["body"].startswith("Cancel at least"))

    g = ExtractedSnippet(kind="guideline", title="Payments", body="Cash or card.")
    c = ExtractedSnippet(kind="content", title="Payments", body="We take all major cards.")
    _, snippets = _merge([(_batch(snippets=[g, c]), None)])
    check("same title, different kind -> NOT merged", len(snippets) == 2, str(len(snippets)))


def test_catalog_block():
    print("\n\033[1m3) build_catalog_block\033[0m")

    items = [
        {"kind": "service", "name": "Teeth Cleaning", "price_text": "AED 300",
         "duration_min": 30, "description": "Scale and polish."},
        {"kind": "product", "name": "Whitening Kit", "price_amount": 250, "currency": "AED"},
    ]
    facts = [{"kind": "content", "title": "Location", "body": "Downtown Dubai."}]
    block = build_catalog_block(items, facts)
    check("block is rendered", block is not None)
    assert block is not None
    check("authoritative header present", block.startswith("OFFICIAL BUSINESS CATALOG"))
    check("service line renders price + duration + description",
          "- Teeth Cleaning — AED 300, 30 min. Scale and polish." in block, block)
    check("Services/Products/Key facts sections present",
          "Services:" in block and "Products:" in block and "Key facts:" in block)
    check("product falls back to currency + amount", "- Whitening Kit — AED 250." in block, block)
    check("fact renders as 'title: body'", "- Location: Downtown Dubai." in block)

    long_desc = "x" * 500
    block = build_catalog_block(
        [{"kind": "service", "name": "Implant", "description": long_desc}], []
    )
    assert block is not None
    line = next(ln for ln in block.splitlines() if ln.startswith("- Implant"))
    check("description truncated to 300 chars", len(line) <= len("- Implant. ") + 300, str(len(line)))
    check("truncation actually cut the text", "x" * 301 not in block)

    many = [{"kind": "service", "name": f"Service number {i:04d}", "description": "d" * 200}
            for i in range(100)]
    block = build_catalog_block(many, [])
    assert block is not None
    check("whole block capped at 4000 chars", len(block) <= 4000, str(len(block)))
    check("cap drops whole lines (block still line-shaped)",
          all(ln.startswith(("OFFICIAL", "Services:", "- ")) for ln in block.splitlines()))

    check("None when nothing to show", build_catalog_block([], []) is None)
    check("content-only still renders",
          build_catalog_block([], [{"title": "T", "body": "B"}]) is not None)


def test_guidelines_block():
    print("\n\033[1m4) build_guidelines_block\033[0m")

    check("None on empty", build_guidelines_block([]) is None)

    block = build_guidelines_block(
        [{"title": "Cancellations", "body": "24 hours notice or a fee applies."}]
    )
    assert block is not None
    check("header present", block.startswith("BUSINESS GUIDELINES"))
    check("bullet renders as 'title: body'", "- Cancellations: 24 hours notice" in block)

    block = build_guidelines_block([{"title": "Long", "body": "y" * 500}])
    assert block is not None
    check("body truncated to 300 chars", "y" * 301 not in block)

    many = [{"title": f"Rule {i:03d}", "body": "b" * 150} for i in range(50)]
    block = build_guidelines_block(many)
    assert block is not None
    check("whole block capped at 2000 chars", len(block) <= 2000, str(len(block)))


def test_request_models():
    print("\n\033[1m5) admin API request models\033[0m")
    try:
        from app.admin_api import CreateCatalogItem, CreateSnippet, UpdateCatalogItem
    except Exception as exc:  # pragma: no cover — env-dependent import, not a failure here
        print(f"   SKIP admin_api not importable in this environment ({exc})")
        return

    def rejects(build):
        try:
            build()
            return False
        except Exception:
            return True

    check("blank item name rejected",
          rejects(lambda: CreateCatalogItem(kind="service", name="   ")))
    check("valid item accepted",
          CreateCatalogItem(kind="service", name="  Cleaning  ").name == "Cleaning")
    check("duration 0 rejected",
          rejects(lambda: CreateCatalogItem(kind="service", name="X", duration_min=0)))
    check("duration 601 rejected",
          rejects(lambda: CreateCatalogItem(kind="service", name="X", duration_min=601)))
    check("duration 600 accepted",
          CreateCatalogItem(kind="service", name="X", duration_min=600).duration_min == 600)
    check("negative price rejected",
          rejects(lambda: CreateCatalogItem(kind="service", name="X", price_amount=-1)))
    check("bad kind rejected",
          rejects(lambda: CreateCatalogItem(kind="membership", name="X")))
    check("patch model: blank name rejected", rejects(lambda: UpdateCatalogItem(name=" ")))
    check("patch model: empty body allowed (no-op patch)",
          UpdateCatalogItem().model_dump(exclude_unset=True) == {})
    check("blank snippet title rejected",
          rejects(lambda: CreateSnippet(kind="guideline", title=" ", body="b")))
    check("overlong snippet body rejected",
          rejects(lambda: CreateSnippet(kind="guideline", title="T", body="b" * 5001)))


def main():
    test_merge_items()
    test_merge_snippets()
    test_catalog_block()
    test_guidelines_block()
    test_request_models()
    print("\n" + "=" * 56)
    if FAILURES:
        print(f"  {len(FAILURES)} FAILURES: {FAILURES}")
        raise SystemExit(1)
    print("  ALL CATALOG TESTS PASSED")
    print("=" * 56)


if __name__ == "__main__":
    main()
