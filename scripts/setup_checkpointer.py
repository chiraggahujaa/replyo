"""One-time checkpointer setup.

LangGraph's Postgres checkpointer stores its state in a handful of tables
(`checkpoints`, `checkpoint_writes`, `checkpoint_blobs`, ...). They must be
created once before the graph can persist anything. Running `.setup()` is
idempotent — safe to run again; it only creates what's missing and applies any
pending migrations.

Run:  python scripts/setup_checkpointer.py
"""

from __future__ import annotations

from langgraph.checkpoint.postgres import PostgresSaver

from app.config import settings


def main() -> None:
    print("Connecting to Postgres and creating checkpointer tables...")
    # Sync saver is fine for a one-off setup script.
    with PostgresSaver.from_conn_string(settings.database_url) as saver:
        saver.setup()
    print("Done. Checkpointer tables are ready.")


if __name__ == "__main__":
    main()
