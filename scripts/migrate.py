"""Apply database migrations to this project's Supabase database.

Reads `DATABASE_URL` from `.env` and runs `supabase db push --db-url ...`. Passing the
DB URL directly (instead of `supabase link`) means the CLI never touches Supabase's
management API — so it doesn't matter which Supabase account your CLI is logged into.
That's the whole point: this project's database can live under a different account than
your global `supabase login`, and migrations still just work.

Any extra arguments are forwarded to `supabase db push` (e.g. `--dry-run` to preview
without applying, `--debug` to troubleshoot).

Run:  uv run python scripts/migrate.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    if shutil.which("supabase") is None:
        print(
            "supabase CLI not found on PATH — install it: "
            "https://supabase.com/docs/guides/cli",
            file=sys.stderr,
        )
        return 1

    # .env value wins; fall back to an already-exported env var.
    db_url = dotenv_values(ROOT / ".env").get("DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL is not set in .env (or the environment).", file=sys.stderr)
        return 1

    extra = sys.argv[1:]
    # Never echo the URL itself — it carries the database password.
    print("Applying migrations: supabase db push --db-url <DATABASE_URL from .env>", *extra, flush=True)
    # cwd=ROOT so the CLI finds supabase/config.toml + supabase/migrations/ regardless
    # of where this script was invoked from. stdin is inherited, so any confirmation
    # prompt from `db push` still works interactively.
    return subprocess.run(
        ["supabase", "db", "push", "--db-url", db_url, *extra],
        cwd=ROOT,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
