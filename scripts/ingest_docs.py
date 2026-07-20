"""Ingest the clinic's documents into pgvector.

Reads every `*.md` file in `data/`, splits each into overlapping chunks, embeds
them, and writes them to the `clinic_docs` collection on Supabase. Re-running is
safe — it wipes and rebuilds the collection so you never get duplicate chunks.

Run:  uv run python scripts/ingest_docs.py
"""

from __future__ import annotations

from pathlib import Path

from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.rag import COLLECTION_NAME, build_store

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def main() -> None:
    files = sorted(DATA_DIR.glob("*.md"))
    if not files:
        raise SystemExit(f"No .md files found in {DATA_DIR}")

    # Chunk so each piece is small enough to be a precise citation but keeps context.
    splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=100)

    docs: list[Document] = []
    for path in files:
        text = path.read_text(encoding="utf-8")
        for chunk in splitter.split_text(text):
            # `source` is what we cite back to the user.
            docs.append(Document(page_content=chunk, metadata={"source": path.name}))

    print(f"Loaded {len(files)} files -> {len(docs)} chunks. Writing to '{COLLECTION_NAME}'...")
    store = build_store(pre_delete=True)  # clean slate each run
    store.add_documents(docs)
    print("Done. Documents are embedded and searchable.")


if __name__ == "__main__":
    main()
