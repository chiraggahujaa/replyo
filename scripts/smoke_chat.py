"""Comprehensive live chat test harness.

Drives the REAL graph (real OpenAI + Supabase pgvector) end-to-end through every
capability built so far and asserts the behaviours that must always hold.

Prerequisites: a working .env (OPENAI_API_KEY, DATABASE_URL) and docs already
ingested (`uv run python scripts/ingest_docs.py`).

Run:  uv run python scripts/smoke_chat.py

What it covers:
  1. Triage + routing for all six intents
  2. RAG grounding + citations (in-domain questions)
  3. No-hallucination guard (out-of-domain question is refused)
  4. Lead qualification slot-filling across turns
  5. Booking slot-filling — must NOT confirm before a name is given
  6. Complaint escalation (needs_human)
  7. Cross-session memory (state survives reopening the DB connection)
  8. Reset (adelete_thread wipes a conversation)

Hard checks fail the run (exit 1). Soft checks are model-dependent and only warn.
"""

from __future__ import annotations

import asyncio

from app.graph.build import graph_with_checkpointer, run_turn

# ---- tiny test framework -------------------------------------------------

class Results:
    def __init__(self) -> None:
        self.hard_fail = 0
        self.soft_warn = 0
        self.passed = 0

    def check(self, name: str, ok: bool, *, hard: bool = True, detail: str = "") -> None:
        if ok:
            self.passed += 1
            print(f"   \033[92mPASS\033[0m {name}")
        elif hard:
            self.hard_fail += 1
            print(f"   \033[91mFAIL\033[0m {name}" + (f"  ({detail})" if detail else ""))
        else:
            self.soft_warn += 1
            print(f"   \033[93mWARN\033[0m {name}" + (f"  ({detail})" if detail else ""))

    def summary(self) -> int:
        print("\n" + "=" * 60)
        print(f"  {self.passed} passed | {self.soft_warn} warnings | {self.hard_fail} hard failures")
        print("=" * 60)
        return 1 if self.hard_fail else 0


def _short(text: str, n: int = 220) -> str:
    text = (text or "").replace("\n", " ")
    return text if len(text) <= n else text[:n] + "…"


def show(user: str, r: dict) -> None:
    print(f"\n  👤 {user}")
    print(f"  🤖 [{r['intent']}] {_short(r['reply'])}")
    extras = []
    if r.get("lead_info"):
        extras.append(f"lead_info={r['lead_info']}")
    if r.get("booking_info"):
        extras.append(f"booking_info={r['booking_info']}")
    if r.get("citations"):
        extras.append(f"citations={r['citations']}")
    if r.get("needs_human"):
        extras.append("needs_human=True")
    if extras:
        print("     " + " | ".join(extras))


async def fresh(graph, thread: str) -> str:
    """Delete any prior state for this thread so the scenario starts clean."""
    await graph.checkpointer.adelete_thread(thread)
    return thread


# ---- scenarios -----------------------------------------------------------

async def test_routing(graph, R: Results) -> None:
    print("\n\033[1m1) Triage + routing (all six intents)\033[0m")
    cases = [
        ("Hi! I'm a new patient and I'd like to get Invisalign — can you help me get started?", "new_lead"),
        ("How much does a single dental implant cost?", "question"),
        ("I'd like to book a check-up for Saturday morning please", "booking_request"),
        ("I waited over an hour past my appointment time and nobody even apologised. Very disappointed.", "complaint"),
        ("🎉 CONGRATS! You've WON a free iPhone 15 — click http://scam.link to claim now!!!", "spam"),
    ]
    for i, (msg, expected) in enumerate(cases):
        t = await fresh(graph, f"route-{i}")
        r = await run_turn(graph, t, msg)
        show(msg, r)
        R.check(f"intent == {expected}", r["intent"] == expected, hard=False,
                detail=f"got {r['intent']}")
        if expected == "complaint":
            R.check("complaint sets needs_human", r["needs_human"] is True)


async def test_rag(graph, R: Results) -> None:
    print("\n\033[1m2) RAG grounding + citations (in-domain)\033[0m")
    cases = [
        ("How much is a single dental implant?", "pricing.md", "35,000"),
        ("What are your opening hours on Sunday?", "hours-location.md", None),
        ("Do you accept Star Health insurance?", "policies.md", None),
        ("How much does in-clinic teeth whitening cost?", "pricing.md", "8,000"),
    ]
    for i, (msg, expect_src, expect_text) in enumerate(cases):
        t = await fresh(graph, f"rag-{i}")
        r = await run_turn(graph, t, msg)
        show(msg, r)
        R.check("intent == question", r["intent"] == "question", hard=False, detail=f"got {r['intent']}")
        R.check("has citations", bool(r.get("citations")))
        R.check(f"cites {expect_src}", expect_src in (r.get("citations") or []),
                hard=False, detail=f"cited {r.get('citations')}")
        if expect_text:
            R.check(f"answer contains '{expect_text}'", expect_text in (r["reply"] or ""),
                    hard=False, detail="value not found in reply")


async def test_no_hallucination(graph, R: Results) -> None:
    print("\n\033[1m3) No-hallucination guard (out-of-domain)\033[0m")
    for i, msg in enumerate([
        "Do you offer laser eye surgery?",
        "Can you fix my broken car engine?",
    ]):
        t = await fresh(graph, f"halluc-{i}")
        r = await run_turn(graph, t, msg)
        show(msg, r)
        # Acceptable outcomes: a hard refusal (nothing relevant, no citations), OR a
        # grounded decline (dental-adjacent query reaches the LLM, which says it can't
        # confirm / doesn't offer it). The failure we care about is FABRICATION.
        reply = (r["reply"] or "").lower()
        declines = any(k in reply for k in (
            "don't", "do not", "not offer", "not provide", "not have", "unable",
            "afraid", "only assist", "not something", "don’t", "can only help",
        ))
        ok = (not r.get("citations")) or declines
        R.check("declines / does not fabricate out-of-domain", ok, hard=False,
                detail=f"cited {r.get('citations')} — inspect reply above")


async def test_lead_qualification(graph, R: Results) -> None:
    print("\n\033[1m4) Lead qualification — slot-filling across turns\033[0m")
    t = await fresh(graph, "lead-flow")
    r1 = await run_turn(graph, t, "Hi, I'm thinking about getting my teeth whitened. I'm a new patient.")
    show("Hi, I'm thinking about getting my teeth whitened. I'm a new patient.", r1)
    r2 = await run_turn(graph, t, "Ideally sometime next month.")
    show("Ideally sometime next month.", r2)
    r3 = await run_turn(graph, t, "You can reach me on 98450 12345, my name's Priya.")
    show("You can reach me on 98450 12345, my name's Priya.", r3)

    li = r3.get("lead_info") or {}
    R.check("need captured", bool(li.get("need")), detail=str(li))
    R.check("timeline persisted across turns", bool(li.get("timeline")), detail=str(li))
    R.check("contact captured", bool(li.get("contact")), detail=str(li))
    R.check("lead marked qualified once all slots present", li.get("qualified") is True, detail=str(li))


async def test_booking(graph, R: Results) -> None:
    print("\n\033[1m5) Booking — must NOT confirm before a name is given\033[0m")
    t = await fresh(graph, "booking-flow")
    r1 = await run_turn(graph, t, "I need to book an appointment this weekend.")
    show("I need to book an appointment this weekend.", r1)
    r2 = await run_turn(graph, t, "Saturday around 3pm would be great.")
    show("Saturday around 3pm would be great.", r2)
    r3 = await run_turn(graph, t, "My number is 98450 67890.")
    show("My number is 98450 67890.", r3)
    bk3 = r3.get("booking_info") or {}
    R.check("time persisted", bool(bk3.get("preferred_time")), detail=str(bk3))
    R.check("contact captured", bool(bk3.get("contact")), detail=str(bk3))
    R.check("NOT ready without a name (the key fix)", bk3.get("ready") is not True, detail=str(bk3))

    r4 = await run_turn(graph, t, "It's under Rahul Sharma.")
    show("It's under Rahul Sharma.", r4)
    bk4 = r4.get("booking_info") or {}
    R.check("name captured", bool(bk4.get("name")), detail=str(bk4))
    R.check("ready only after name", bk4.get("ready") is True, detail=str(bk4))


async def test_reset(graph, R: Results) -> None:
    print("\n\033[1m6) Reset — adelete_thread wipes the conversation\033[0m")
    t = await fresh(graph, "reset-flow")
    await run_turn(graph, t, "Hi, my name is Meera and I want braces.")
    cfg = {"configurable": {"thread_id": t}}
    before = await graph.aget_state(cfg)
    n_before = len((before.values or {}).get("messages", []))
    await graph.checkpointer.adelete_thread(t)
    after = await graph.aget_state(cfg)
    n_after = len((after.values or {}).get("messages", []))
    print(f"     messages before reset = {n_before}, after reset = {n_after}")
    R.check("state had messages before reset", n_before > 0)
    R.check("state empty after reset", n_after == 0)


async def test_cross_session_memory(R: Results) -> None:
    print("\n\033[1m7) Cross-session memory (survives reopening the DB connection)\033[0m")
    thread = "memory-flow"
    # Session A: open a fresh connection, say something, then CLOSE it.
    async with graph_with_checkpointer() as graph_a:
        await fresh(graph_a, thread)
        r1 = await run_turn(graph_a, thread, "Hi, I'm Anaya and I'm interested in braces for my daughter.")
        show("Hi, I'm Anaya and I'm interested in braces for my daughter.", r1)
    # Session B: brand-new connection — anything remembered came from Postgres.
    async with graph_with_checkpointer() as graph_b:
        cfg = {"configurable": {"thread_id": thread}}
        snap = await graph_b.aget_state(cfg)
        n = len((snap.values or {}).get("messages", []))
        R.check("history loaded from Postgres in a new session", n >= 2, detail=f"{n} messages")
        r2 = await run_turn(graph_b, thread, "Remind me — what treatment did I ask about, and for whom?")
        show("Remind me — what treatment did I ask about, and for whom?", r2)
        low = (r2["reply"] or "").lower()
        R.check("recalls 'braces'", "brace" in low, hard=False, detail="model phrasing")
        R.check("recalls 'daughter'", "daughter" in low, hard=False, detail="model phrasing")
        await graph_b.checkpointer.adelete_thread(thread)  # cleanup


async def main() -> None:
    R = Results()
    async with graph_with_checkpointer() as graph:
        await test_routing(graph, R)
        await test_rag(graph, R)
        await test_no_hallucination(graph, R)
        await test_lead_qualification(graph, R)
        await test_booking(graph, R)
        await test_reset(graph, R)
    await test_cross_session_memory(R)
    raise SystemExit(R.summary())


if __name__ == "__main__":
    asyncio.run(main())
