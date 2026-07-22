"""Deterministic tests for the WhatsApp webhook parsing + dedup.

Meta's payload nesting is awkward and its webhook delivers more than just user
messages, so `parse_inbound()` is a pure function and gets tested directly — no
tunnel, no Meta app, no network.

Run:  uv run python scripts/test_whatsapp.py
"""

from __future__ import annotations

from app.channels.whatsapp import _SeenMessages, parse_inbound

FAILURES = []


def check(name, ok, detail=""):
    print(("   PASS " if ok else "   FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)


def envelope(*messages, statuses=None):
    """Wrap message objects in Meta's entry[].changes[].value shape."""
    value = {"messaging_product": "whatsapp", "metadata": {"phone_number_id": "555"}}
    if messages:
        value["messages"] = list(messages)
    if statuses:
        value["statuses"] = statuses
    return {"object": "whatsapp_business_account",
            "entry": [{"id": "WABA", "changes": [{"field": "messages", "value": value}]}]}


def text_msg(mid="wamid.1", frm="919876543210", body="Hi, do you do whitening?"):
    return {"id": mid, "from": frm, "timestamp": "1700000000",
            "type": "text", "text": {"body": body}}


def test_parsing():
    print("\n\033[1m1) parse_inbound() — real payload shapes\033[0m")

    msgs = parse_inbound(envelope(text_msg()))
    check("extracts a text message", len(msgs) == 1, str(msgs))
    if msgs:
        m = msgs[0]
        check("captures the sender", m.from_number == "919876543210", m.from_number)
        check("captures the body", m.text == "Hi, do you do whitening?", m.text)
        check("captures the message id (for dedup)", m.message_id == "wamid.1", m.message_id)
        check("namespaces the thread id", m.thread_id == "whatsapp:919876543210", m.thread_id)

    # Delivery receipts arrive on the SAME webhook and must never be treated as input.
    statuses = [{"id": "wamid.1", "status": "delivered", "recipient_id": "919876543210"}]
    check("ignores status callbacks", parse_inbound(envelope(statuses=statuses)) == [])

    # Non-text messages have no text.body for the graph to read.
    image = {"id": "wamid.2", "from": "91999", "type": "image", "image": {"id": "media-1"}}
    check("ignores non-text messages", parse_inbound(envelope(image)) == [])

    # Mixed batch: Meta can deliver several messages in one POST.
    both = parse_inbound(envelope(text_msg("wamid.3", "9111", "one"),
                                  image,
                                  text_msg("wamid.4", "9222", "two")))
    check("handles a mixed batch", len(both) == 2, str(both))

    check("blank body is skipped", parse_inbound(envelope(text_msg(body="   "))) == [])
    check("malformed payload -> empty", parse_inbound({}) == [])
    check("missing entry -> empty", parse_inbound({"object": "x"}) == [])


def test_dedup():
    print("\n\033[1m2) Retry protection\033[0m")
    seen = _SeenMessages(maxlen=3)
    check("first delivery is new", seen.seen("a") is False)
    check("retry of same id is caught", seen.seen("a") is True)
    check("a different id is new", seen.seen("b") is False)

    # Bounded: oldest ids fall out so memory can't grow without limit.
    seen.seen("c")
    seen.seen("d")  # evicts "a"
    check("evicts oldest when full", seen.seen("a") is False, "expected 'a' to have been evicted")


def main():
    test_parsing()
    test_dedup()
    print("\n" + "=" * 56)
    if FAILURES:
        print(f"  {len(FAILURES)} FAILURES: {FAILURES}")
        raise SystemExit(1)
    print("  ALL WHATSAPP TESTS PASSED")
    print("=" * 56)


if __name__ == "__main__":
    main()
