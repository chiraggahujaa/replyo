"""Deterministic tests for the Step 7 follow-up decision logic.

`follow_up_reason()` decides who gets a re-engagement nudge and who is deliberately
left alone. It's pure (no DB, no LLM), so this runs fully offline.

Run:  uv run python scripts/test_followups.py
"""

from __future__ import annotations

from app.followups import follow_up_reason

FAILURES = []


def check(name, ok, detail=""):
    print(("   PASS " if ok else "   FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)


def test_no_nudge_cases():
    print("\n\033[1m1) Conversations we must NOT chase\033[0m")

    converted = {"intent": "booking_request", "booking_info": {"status": "confirmed"}}
    check("confirmed booking -> no nudge", follow_up_reason(converted) is None,
          str(follow_up_reason(converted)))

    # A confirmed booking wins even if lead details are on file.
    converted_lead = {
        "intent": "booking_request",
        "booking_info": {"status": "confirmed"},
        "lead_info": {"need": "braces"},
    }
    check("converted lead -> no nudge", follow_up_reason(converted_lead) is None)

    escalated = {"intent": "complaint", "needs_human": True, "lead_info": {"need": "crown"}}
    check("escalated complaint -> no nudge (human owns it)", follow_up_reason(escalated) is None)

    spam = {"intent": "spam", "lead_info": {"need": "whatever"}}
    check("spam -> no nudge", follow_up_reason(spam) is None)

    existing = {"intent": "existing_customer"}
    check("plain existing-customer chat -> no nudge", follow_up_reason(existing) is None)

    check("empty turn -> no nudge", follow_up_reason({}) is None)


def test_nudge_cases():
    print("\n\033[1m2) Conversations we SHOULD re-engage\033[0m")

    stalled = {"intent": "booking_request", "booking_info": {"status": "collecting"}}
    r = follow_up_reason(stalled)
    check("half-finished booking -> nudge", r is not None and "never confirmed" in r, str(r))

    conflicted = {"intent": "booking_request", "booking_info": {"status": "conflict"}}
    check("unresolved conflict -> nudge", follow_up_reason(conflicted) is not None)

    lead = {"intent": "new_lead", "lead_info": {"need": "teeth whitening"}}
    r = lead_reason = follow_up_reason(lead)
    check("lead with a need -> nudge mentions the need",
          r is not None and "teeth whitening" in r, str(r))

    bare_lead = {"intent": "new_lead", "lead_info": {"timeline": "next month"}}
    check("lead without a stated need -> generic nudge", follow_up_reason(bare_lead) is not None)

    question = {"intent": "question"}
    r = follow_up_reason(question)
    check("question but no booking -> nudge", r is not None, str(r))

    print(f"\n   e.g. lead reason -> {lead_reason!r}")


def main():
    test_no_nudge_cases()
    test_nudge_cases()
    print("\n" + "=" * 56)
    if FAILURES:
        print(f"  {len(FAILURES)} FAILURES: {FAILURES}")
        raise SystemExit(1)
    print("  ALL FOLLOW-UP TESTS PASSED")
    print("=" * 56)


if __name__ == "__main__":
    main()
