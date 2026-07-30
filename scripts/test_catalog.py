"""Deterministic tests for the business-catalog pipeline's pure pieces.

Covers `_merge` and `_merge_contact` (dedupe/coalesce and first-wins rules in
app/extraction.py), the contact validators and prompt-block builders in app/catalog.py,
the admin API request-model validation, and the keyset cursor/limit helpers behind
GET /api/personas/active/catalog/entries. All pure — no network, no database, no LLM.

Run:  uv run python scripts/test_catalog.py
"""

from __future__ import annotations

from app.catalog import (
    CONTACT_FIELDS,
    build_catalog_block,
    build_guidelines_block,
    clean_contact,
    contact_from_profile,
    contact_lines,
)
from app.extraction import (
    ExtractedContact,
    ExtractedItem,
    ExtractedSnippet,
    ExtractionBatch,
    _merge,
    _merge_contact,
)

FAILURES = []


def check(name, ok, detail=""):
    print(("   PASS " if ok else "   FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)


def _batch(items=(), snippets=()):
    return ExtractionBatch(items=list(items), snippets=list(snippets))


def test_merge_items():
    print("\n\033[1m1) _merge — item dedupe\033[0m")

    poor = ExtractedItem(kind="service", name="Teeth Cleaning", price_text="₹1,500")
    rich = ExtractedItem(
        kind="service", name="  teeth   CLEANING ", description="Scale and polish",
        price_amount=1500.0, currency="INR",
    )
    items, _ = _merge([(_batch([poor]), "pricelist.md"), (_batch([rich]), "https://x.com/services")])
    check("same name, different case/whitespace -> one item", len(items) == 1, str(len(items)))
    it = items[0]
    check("richer candidate wins (its description kept)", it["description"] == "Scale and polish")
    check("winner's batch source attached", it["source"] == "https://x.com/services", str(it["source"]))
    check("field coalesce: winner's gap filled from loser (price_text)",
          it["price_text"] == "₹1,500", str(it["price_text"]))
    check("winner's own fields survive the coalesce",
          it["price_amount"] == 1500.0 and it["currency"] == "INR",
          f"{it['price_amount']!r} / {it['currency']!r}")

    a = ExtractedItem(kind="product", name="Whitening Kit", price_text="₹5,000")
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
        {"kind": "service", "name": "Teeth Cleaning", "price_text": "₹1,500",
         "duration_min": 30, "description": "Scale and polish."},
        {"kind": "product", "name": "Whitening Kit", "price_amount": 5000, "currency": "INR"},
    ]
    facts = [{"kind": "content", "title": "Location", "body": "Downtown Dubai."}]
    block = build_catalog_block(items, facts)
    check("block is rendered", block is not None)
    assert block is not None
    check("authoritative header present", block.startswith("OFFICIAL BUSINESS CATALOG"))
    check("service line renders price + duration + description",
          "- Teeth Cleaning — ₹1,500, 30 min. Scale and polish." in block, block)
    check("Services/Products/Key facts sections present",
          "Services:" in block and "Products:" in block and "Key facts:" in block)
    # No price_text on this row, so _item_line renders the amount through
    # app/currency.format_amount — symbol + Indian digit grouping, not "INR 5000".
    check("product falls back to formatted amount", "- Whitening Kit — ₹5,000." in block, block)
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


def test_contact():
    print("\n\033[1m5) contact details — cleaning, merging, rendering\033[0m")

    # --- clean_contact_value's per-field rules, via clean_contact ------------------
    cleaned = clean_contact({
        "phone": "  +91 98765   43210 ",
        "email": "Hello@Example.com",
        "address": "12 MG Road\nBengaluru 560001",
        "website": "brightsmile.in",
        "maps_url": "https://maps.app.goo.gl/AbCdEf",
    })
    check("whitespace collapsed to one line (phone)", cleaned["phone"] == "+91 98765 43210",
          repr(cleaned.get("phone")))
    check("a multi-line address becomes one line",
          cleaned["address"] == "12 MG Road Bengaluru 560001", repr(cleaned.get("address")))
    check("email kept verbatim (case included)", cleaned["email"] == "Hello@Example.com")
    check("scheme-less domain accepted", cleaned["website"] == "brightsmile.in")
    check("map link accepted", cleaned["maps_url"].endswith("AbCdEf"))

    for label, raw in (
        ("phone with no digits", {"phone": "call the front desk"}),
        ("phone with too few digits", {"phone": "ext. 12"}),
        ("email with no @", {"email": "hello.example.com"}),
        ("email with no dotted domain", {"email": "hello@example"}),
        ("website that's prose", {"website": "see our site for details"}),
        ("blank value", {"phone": "   "}),
        ("wrong type", {"phone": 9876543210}),
    ):
        check(f"unusable ({label}) is dropped", clean_contact(raw) == {}, str(clean_contact(raw)))

    check("unknown keys are dropped",
          clean_contact({"fax": "123456", "instagram": "@x"}) == {})
    check("non-dict input -> {}", clean_contact("+91 98765 43210") == {} and clean_contact(None) == {})
    check("value capped at 200 chars",
          len(clean_contact({"address": "a" * 500})["address"]) == 200,
          str(len(clean_contact({"address": "a" * 500})["address"])))

    # Field order is CONTACT_FIELDS order regardless of the order keys arrived in — the
    # stored jsonb has to read the way the card displays.
    reordered = clean_contact({
        "maps_url": "https://maps.app.goo.gl/x", "email": "a@b.co", "phone": "011-4123 4567",
    })
    check("keys come back in CONTACT_FIELDS order",
          list(reordered) == [f for f in CONTACT_FIELDS if f in reordered]
          and list(reordered) == ["phone", "email", "maps_url"], str(list(reordered)))

    check("profile with no contact -> {}", contact_from_profile({"hours": None}) == {})
    check("no profile at all -> {}", contact_from_profile(None) == {})
    check("profile contact is re-validated on the way out",
          contact_from_profile({"contact": {"phone": "nope", "email": "a@b.co"}})
          == {"email": "a@b.co"})

    # --- _merge_contact: first valid value per field wins --------------------------
    def merged(*contacts):
        return _merge_contact([
            (ExtractionBatch(contact=ExtractedContact(**c) if c is not None else None), None)
            for c in contacts
        ])

    check("nothing stated -> None", merged(None, None) is None, str(merged(None, None)))
    check("no batches at all -> None", _merge_contact([]) is None)

    got = merged({"phone": "011-4123 4567"}, {"phone": "022-9999 0000"})
    check("first batch owns the field it claimed", got == {"phone": "011-4123 4567"}, str(got))

    got = merged({"phone": "011-4123 4567"}, {"address": "12 MG Road", "email": "a@b.co"})
    check("fields from different batches add up",
          got == {"phone": "011-4123 4567", "email": "a@b.co", "address": "12 MG Road"}, str(got))

    # An invalid claim must not CLAIM the field — a good value later still fills it.
    got = merged({"phone": "call us"}, {"phone": "011-4123 4567"})
    check("an invalid claim leaves the field unclaimed", got == {"phone": "011-4123 4567"}, str(got))

    got = merged({"email": "not-an-email"}, None)
    check("only-invalid claims -> None (nothing to write)", got is None, str(got))

    # --- contact_lines + the block section ----------------------------------------
    check("no contact -> no lines", contact_lines({}) == [] and contact_lines(None) == [])
    lines = contact_lines({"phone": "011-4123 4567", "address": "12 MG Road"})
    check("section header first", lines[0] == "Contact details:", str(lines[:1]))
    check("labelled bullets, in field order",
          lines[1:] == ["- Phone: 011-4123 4567", "- Address: 12 MG Road"], str(lines[1:]))

    block = build_catalog_block(
        [{"kind": "service", "name": "Cleaning", "price_text": "₹1,500"}],
        [{"title": "Location", "body": "Central."}],
        hours_text="Mon–Fri 9am–6pm",
        contact={"phone": "011-4123 4567", "website": "brightsmile.in"},
    )
    assert block is not None
    check("contact section renders in the catalog block", "- Phone: 011-4123 4567" in block, block)
    check("contact sits between hours and key facts",
          block.index("Opening hours:") < block.index("Contact details:") < block.index("Key facts:"),
          block)
    check("contact-only catalog still renders a block",
          build_catalog_block([], [], contact={"phone": "011-4123 4567"}) is not None)
    check("no contact -> no contact section",
          "Contact details:" not in (build_catalog_block(
              [{"kind": "service", "name": "Cleaning"}], []) or ""))


def test_request_models():
    print("\n\033[1m6) admin API request models\033[0m")
    try:
        from app.admin_api import (
            CreateCatalogItem,
            CreateSnippet,
            UpdateBusinessSettings,
            UpdateCatalogItem,
        )
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

    # --- the contact card: an owner's bad value is a 422, not a silent drop ---------
    check("valid contact accepted and normalized",
          UpdateBusinessSettings(contact={"phone": " 011-4123  4567 "}).contact
          == {"phone": "011-4123 4567"},
          str(UpdateBusinessSettings(contact={"phone": " 011-4123  4567 "}).contact))
    check("blank field is dropped, not rejected (that's how one is cleared)",
          UpdateBusinessSettings(contact={"phone": "   ", "email": "a@b.co"}).contact
          == {"email": "a@b.co"})
    check("empty card accepted (owner publishes no details)",
          UpdateBusinessSettings(contact={}).contact == {})
    check("contact: null accepted (hand the card back to extraction)",
          UpdateBusinessSettings(contact=None).model_dump(exclude_unset=True) == {"contact": None})
    check("unknown contact field rejected",
          rejects(lambda: UpdateBusinessSettings(contact={"fax": "011-4123 4567"})))
    check("bad email rejected", rejects(lambda: UpdateBusinessSettings(contact={"email": "nope"})))
    check("digitless phone rejected",
          rejects(lambda: UpdateBusinessSettings(contact={"phone": "call us"})))
    check("overlong value rejected",
          rejects(lambda: UpdateBusinessSettings(contact={"address": "a" * 201})))
    check("contact keys stored in display order",
          list(UpdateBusinessSettings(
              contact={"website": "x.co", "phone": "011-4123 4567"}).contact or {})
          == ["phone", "website"])
    check("hours-only patch leaves contact unset (so it isn't claimed)",
          "contact" not in UpdateBusinessSettings(slot_minutes=45).model_dump(exclude_unset=True))


def test_pagination_cursors():
    print("\n\033[1m7) catalog entries — cursor + limit helpers\033[0m")
    try:
        from app.admin_api import (
            ENTRIES_LIMIT_DEFAULT,
            clamp_entries_limit,
            decode_cursor,
            encode_cursor,
        )
    except Exception as exc:  # pragma: no cover — env-dependent import, not a failure here
        print(f"   SKIP admin_api not importable in this environment ({exc})")
        return

    # --- round-trip, both tuple shapes -------------------------------------------
    item_key = [0, "restorative", "root canal", "6f1a3c2e-0000-4000-8000-000000000001"]
    snippet_key = [3, "cancellation policy", "6f1a3c2e-0000-4000-8000-000000000002"]
    check("item tuple round-trips", decode_cursor(encode_cursor(item_key)) == item_key)
    check("snippet tuple round-trips", decode_cursor(encode_cursor(snippet_key)) == snippet_key)
    check("cursor is url-safe (no +/= padding)",
          not (set("+/=") & set(encode_cursor(item_key))), encode_cursor(item_key))

    awkward = [
        1, "", "6f1a3c2e-0000-4000-8000-000000000003",
    ]
    check("empty string survives", decode_cursor(encode_cursor(awkward)) == awkward)
    for label, value in (
        ("non-ASCII", "tratamiento de conducto — ñandú, 日本語"),
        ("double quotes", 'the "premium" clean'),
        ("single quote + backslash", "o'brien\\ back"),
        ("newline + tab", "line1\nline2\tend"),
        ("emoji", "whitening 🦷 kit"),
    ):
        key = [0, value, value, "6f1a3c2e-0000-4000-8000-000000000004"]
        check(f"{label} survives the round-trip", decode_cursor(encode_cursor(key)) == key,
              repr(decode_cursor(encode_cursor(key))))

    # --- malformed cursors decode to None, never raise ---------------------------
    import base64 as _b64
    import json as _json

    valid = encode_cursor(item_key)
    malformed = {
        "empty string": "",
        "None": None,
        "not base64 at all": "this is not base64!!",
        "non-ASCII cursor": "ñot-båse64",
        "base64 of non-JSON": _b64.urlsafe_b64encode(b"just text").decode().rstrip("="),
        "base64 of a JSON object": _b64.urlsafe_b64encode(
            _json.dumps({"k": 1}).encode()).decode().rstrip("="),
        "base64 of a JSON scalar": _b64.urlsafe_b64encode(b"42").decode().rstrip("="),
        "base64 of JSON null": _b64.urlsafe_b64encode(b"null").decode().rstrip("="),
        "truncated cursor": valid[: len(valid) // 2],
        "truncated by one char": valid[:-1],
        "base64 of truncated JSON": _b64.urlsafe_b64encode(b'[0,"a"').decode().rstrip("="),
        "base64 of invalid utf-8": _b64.urlsafe_b64encode(b"\xff\xfe[]").decode().rstrip("="),
    }
    for label, raw in malformed.items():
        try:
            result = decode_cursor(raw)
            ok, detail = result is None, repr(result)
        except Exception as exc:
            ok, detail = False, f"raised {type(exc).__name__}: {exc}"
        check(f"malformed ({label}) -> None, no raise", ok, detail)

    # --- limit clamp --------------------------------------------------------------
    check("default is 15", ENTRIES_LIMIT_DEFAULT == 15, str(ENTRIES_LIMIT_DEFAULT))
    for value, expected in ((0, 1), (1, 1), (15, 15), (50, 50), (51, 50), (-7, 1), (10_000, 50)):
        got = clamp_entries_limit(value)
        check(f"limit {value} -> {expected}", got == expected, str(got))
    for label, value in (("None", None), ("string", "20"), ("float", 12.5), ("bool", True)):
        got = clamp_entries_limit(value)
        check(f"non-int limit ({label}) -> default", got == ENTRIES_LIMIT_DEFAULT, str(got))


def test_entries_route_shape():
    print("\n\033[1m8) catalog entries — keyset wiring (table map + sort/filter agreement)\033[0m")
    try:
        from app.admin_api import _ENTRY_TABLE_FOR_KIND, _ENTRY_TABLES, get_catalog_entries
    except Exception as exc:  # pragma: no cover — env-dependent import
        print(f"   SKIP admin_api not importable in this environment ({exc})")
        return

    check("all four kinds map to a table",
          sorted(_ENTRY_TABLE_FOR_KIND) == ["content", "guideline", "product", "service"])
    check("service/product -> catalog_items",
          {_ENTRY_TABLE_FOR_KIND["service"], _ENTRY_TABLE_FOR_KIND["product"]} == {"catalog_items"})
    check("guideline/content -> business_snippets",
          {_ENTRY_TABLE_FOR_KIND["guideline"], _ENTRY_TABLE_FOR_KIND["content"]}
          == {"business_snippets"})

    for table, spec in _ENTRY_TABLES.items():
        # The keyset filter and the ORDER BY must be built from the same expressions, and
        # the placeholder tuple must have exactly one slot per sort key.
        check(f"{table}: row_value mirrors sort_sql",
              spec["row_value"] == f"({spec['sort_sql']})", spec["row_value"])
        check(f"{table}: one placeholder per key column",
              spec["placeholders"].count("%s") == len(spec["key_columns"])
              == len(spec["types"]), spec["placeholders"])
        check(f"{table}: id is the last sort key", spec["key_columns"][-1] == "id")
        check(f"{table}: id bound as uuid", spec["placeholders"].rstrip(")").endswith("::uuid"))

    check("handler is registered on the router",
          any(getattr(r, "endpoint", None) is get_catalog_entries
              for r in __import__("app.admin_api", fromlist=["router"]).router.routes))


def test_entries_page_assembly():
    print("\n\033[1m9) catalog entries — page assembly (limit+1 -> entries, next_cursor)\033[0m")
    try:
        from app.admin_api import _ENTRY_TABLES, _entries_page, decode_cursor
    except Exception as exc:  # pragma: no cover — env-dependent import
        print(f"   SKIP admin_api not importable in this environment ({exc})")
        return

    import uuid as _uuid

    keys = _ENTRY_TABLES["catalog_items"]["key_columns"]

    def row(i, category="restorative"):
        return {
            "id": _uuid.UUID(f"6f1a3c2e-0000-4000-8000-{i:012d}"),
            "kind": "service", "name": f"Service {i:03d}", "category": category,
            "k1": 0 if category else 1, "k2": (category or ""), "k3": f"service {i:03d}",
        }

    entries, cursor = _entries_page([], 3, keys)
    check("empty fetch -> no entries, no cursor", entries == [] and cursor is None)

    entries, cursor = _entries_page([row(1), row(2)], 3, keys)
    check("short page -> last page (cursor None)", len(entries) == 2 and cursor is None, str(cursor))

    entries, cursor = _entries_page([row(i) for i in range(1, 4)], 3, keys)
    check("exactly `limit` rows -> still the last page", len(entries) == 3 and cursor is None,
          str(cursor))

    fetched = [row(i) for i in range(1, 5)]  # limit+1
    entries, cursor = _entries_page(fetched, 3, keys)
    check("limit+1 rows -> extra dropped", len(entries) == 3, str(len(entries)))
    check("cursor present when more remain", cursor is not None)
    check("cursor names the LAST KEPT row (not the extra)",
          decode_cursor(cursor) == [0, "restorative", "service 003",
                                    "6f1a3c2e-0000-4000-8000-000000000003"],
          str(decode_cursor(cursor)))
    check("uuid id is stringified for JSON", isinstance((decode_cursor(cursor) or [])[-1], str))
    check("helper key columns stripped from the payload",
          all(not ({"k1", "k2", "k3"} & set(e)) for e in entries), str(sorted(entries[0])))
    check("every real column survives",
          sorted(entries[0]) == ["category", "id", "kind", "name"], str(sorted(entries[0])))

    # A null category sorts last, and its cursor carries the flag + the '' collapse.
    entries, cursor = _entries_page([row(i, None) for i in range(1, 3)], 1, keys)
    check("null-category cursor keeps flag=1 and empty category",
          decode_cursor(cursor) == [1, "", "service 001",
                                   "6f1a3c2e-0000-4000-8000-000000000001"],
          str(decode_cursor(cursor)))

    skeys = _ENTRY_TABLES["business_snippets"]["key_columns"]
    srows = [
        {"id": _uuid.UUID("6f1a3c2e-0000-4000-8000-000000000009"), "kind": "content",
         "title": "Location", "body": "b", "sort": 2, "k2": "location"},
        {"id": _uuid.UUID("6f1a3c2e-0000-4000-8000-000000000010"), "kind": "content",
         "title": "Parking", "body": "b", "sort": 3, "k2": "parking"},
    ]
    entries, cursor = _entries_page(srows, 1, skeys)
    check("snippet cursor is (sort, lower(title), id)",
          decode_cursor(cursor) == [2, "location", "6f1a3c2e-0000-4000-8000-000000000009"],
          str(decode_cursor(cursor)))
    check("snippet payload keeps its columns, drops k2",
          sorted(entries[0]) == ["body", "id", "kind", "sort", "title"], str(sorted(entries[0])))


def main():
    test_merge_items()
    test_merge_snippets()
    test_catalog_block()
    test_guidelines_block()
    test_contact()
    test_request_models()
    test_pagination_cursors()
    test_entries_route_shape()
    test_entries_page_assembly()
    print("\n" + "=" * 56)
    if FAILURES:
        print(f"  {len(FAILURES)} FAILURES: {FAILURES}")
        raise SystemExit(1)
    print("  ALL CATALOG TESTS PASSED")
    print("=" * 56)


if __name__ == "__main__":
    main()
