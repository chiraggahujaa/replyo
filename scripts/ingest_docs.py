"""Ingest the demo persona's documents into its pgvector collection.

Reads every `*.md` in `data/`, splits each into overlapping chunks, embeds them, and
writes them to the DEMO tenant's collection — the seed persona that the clinic-site and
the single-tenant channels use. Re-running is safe: it wipes and rebuilds the collection.

Real personas ingest through the dashboard (uploads + website crawl, see app/knowledge.py);
this script is the local-dev seed path for the built-in demo.

Run:  uv run python scripts/ingest_docs.py
"""

from __future__ import annotations

from pathlib import Path

from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.knowledge import CHUNK_OVERLAP, CHUNK_SIZE
from app.rag import build_store, collection_name
from app.tenancy import DEMO_TENANT_ID

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def main() -> None:
    files = sorted(DATA_DIR.glob("*.md"))
    if not files:
        raise SystemExit(f"No .md files found in {DATA_DIR}")

    splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)

    docs: list[Document] = []
    for path in files:
        text = path.read_text(encoding="utf-8")
        for chunk in splitter.split_text(text):
            # `source` is what we cite back to the user.
            docs.append(Document(page_content=chunk, metadata={"source": path.name}))

    coll = collection_name(DEMO_TENANT_ID)
    print(f"Loaded {len(files)} files -> {len(docs)} chunks. Writing to '{coll}'...")
    store = build_store(DEMO_TENANT_ID, pre_delete=True)  # clean slate each run
    store.add_documents(docs)
    print("Done. The demo persona's documents are embedded and searchable.")


if __name__ == "__main__":
    main()
