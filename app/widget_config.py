"""Server-side twin of the widget's appearance config.

The console's Install page saves a tenant's widget customization (name + styling) to
`tenants.widget_config`; the widget fetches it at boot via GET /widget/config. This
module is the single sanitizer used on BOTH paths — write (PATCH /api/personas/active)
and read (the public endpoint) — so whatever ends up in the column, embeds only ever
see whitelisted keys with in-range values.

Keys are camelCase to match the widget's own field names (app/static/widget.js) and
the console's WidgetConfig type (dashboard/app/install/page.tsx). The enums and bounds
here must stay in sync with both.
"""

from __future__ import annotations

import math
import re
import time

THEMES = {"teal", "ocean", "violet", "sunset", "rose", "forest", "crimson", "slate", "custom"}
# For theme "custom": the single brand color the widget derives its palette from,
# and the title/icon ink on it ("auto" = the widget picks by brightness).
HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")
INKS = {"auto", "white", "black"}
MODES = {"light", "dark"}
SIZES = {"compact", "standard", "large", "custom"}
POSITIONS = {"bottom-right", "bottom-left", "top-right", "top-left"}

MIN_W, MAX_W = 320, 480
MIN_H, MAX_H = 420, 720
MAX_OFFSET = 200
NAME_MAX = 60


def _clamped_int(value: object, lo: int, hi: int) -> int | None:
    """A number clamped into [lo, hi], or None for anything that isn't a real finite
    number (bool is an int subclass — reject it explicitly; NaN/Infinity survive
    json.loads and would make round() raise)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return max(lo, min(hi, round(value)))


def sanitize_widget_config(raw: object) -> dict:
    """Keep only known keys with valid values; drop everything else silently.

    Returns a dict safe to store and to serve publicly (never includes anything but
    appearance fields — no prompts, notes, or ids can pass through).
    """
    if not isinstance(raw, dict):
        return {}
    out: dict = {}

    name = raw.get("name")
    if isinstance(name, str) and name.strip():
        out["name"] = name.strip()[:NAME_MAX]

    # isinstance BEFORE membership: `[] in {…}` hashes the value and raises TypeError,
    # so without the type check hostile JSON would 500 the public config endpoint
    # instead of being sanitized away.
    for key, allowed in (("theme", THEMES), ("mode", MODES), ("size", SIZES), ("position", POSITIONS), ("ink", INKS)):
        v = raw.get(key)
        if isinstance(v, str) and v in allowed:
            out[key] = v

    color = raw.get("color")
    if isinstance(color, str) and HEX_COLOR.fullmatch(color):
        out["color"] = color.lower()

    for key, lo, hi in (
        ("width", MIN_W, MAX_W),
        ("height", MIN_H, MAX_H),
        ("offsetX", 0, MAX_OFFSET),
        ("offsetY", 0, MAX_OFFSET),
    ):
        n = _clamped_int(raw.get(key), lo, hi)
        if n is not None:
            out[key] = n

    return out


# ---------------------------------------------------------------------------
# Tiny in-process cache for the public GET /widget/config path: one DB round-trip per
# public key per TTL instead of one per embed page-load (the endpoint fires on every
# boot of every embedded widget, unauthenticated). A None payload caches "unknown key"
# so spamming random keys stops costing a DB connection each. PATCH invalidates in this
# process; other workers converge within the TTL, which appearance data tolerates.
# ---------------------------------------------------------------------------

_CACHE: dict[str, tuple[float, dict | None]] = {}
_TTL_SECONDS = 30.0
_MAX_ENTRIES = 1024  # hostile random keys must not grow memory unboundedly


def cache_get(key: str) -> tuple[bool, dict | None]:
    """(hit, payload). payload None on a hit means the key is known-invalid (404)."""
    entry = _CACHE.get(key)
    if entry is None or entry[0] < time.monotonic():
        return (False, None)
    return (True, entry[1])


def cache_put(key: str, payload: dict | None) -> None:
    if len(_CACHE) >= _MAX_ENTRIES:
        _CACHE.clear()
    _CACHE[key] = (time.monotonic() + _TTL_SECONDS, payload)


def cache_invalidate(key: str) -> None:
    _CACHE.pop(key, None)
