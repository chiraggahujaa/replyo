"""Retrieval-Augmented Generation (RAG) plumbing.

One place that owns:
  - the embedding model (turns text into vectors),
  - the pgvector-backed vector store on Supabase,
  - a `retrieve()` helper the graph uses to fetch relevant document chunks.

Ingestion (chunking the files in data/ and writing embeddings) lives in
scripts/ingest_docs.py; this module is the read side plus the shared store builder.
"""

from __future__ import annotations

from functools import lru_cache

from langchain_core.documents import Document
from langchain_openai import OpenAIEmbeddings
from langchain_postgres import PGVector

from app.config import settings

# Logical name for our set of clinic documents inside pgvector.
COLLECTION_NAME = "clinic_docs"
# 1536-dim, inexpensive, plenty for a small knowledge base.
EMBEDDING_MODEL = "text-embedding-3-small"


def _sqlalchemy_url() -> str:
    """PGVector wants a SQLAlchemy/psycopg URL; our DATABASE_URL is a plain one.

    Rewrites `postgresql://` (or `postgres://`) to `postgresql+psycopg://` so
    SQLAlchemy uses the psycopg 3 driver we installed. Any `?sslmode=require` is
    preserved (psycopg understands it).
    """
    url = settings.database_url
    for prefix in ("postgresql+", ):  # already has an explicit driver
        if url.startswith(prefix):
            return url
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://"):]
    return url


def get_embeddings() -> OpenAIEmbeddings:
    return OpenAIEmbeddings(model=EMBEDDING_MODEL, api_key=settings.openai_api_key)


def build_store(pre_delete: bool = False) -> PGVector:
    """Construct the pgvector store.

    pre_delete=True wipes the collection first — used by the ingest script so
    re-running it doesn't pile up duplicate chunks. `create_extension=True` runs
    `CREATE EXTENSION IF NOT EXISTS vector` on first use (Supabase permits this).
    """
    return PGVector(
        embeddings=get_embeddings(),
        connection=_sqlalchemy_url(),
        collection_name=COLLECTION_NAME,
        use_jsonb=True,
        create_extension=True,
        pre_delete_collection=pre_delete,
    )


@lru_cache
def get_vector_store() -> PGVector:
    """Shared, read-side store (one engine reused across requests)."""
    return build_store(pre_delete=False)


def retrieve(query: str, k: int = 4) -> list[tuple[Document, float]]:
    """Return the k most similar chunks as (Document, distance) pairs.

    Distance is cosine distance: LOWER means MORE similar. The caller applies a
    threshold to decide whether anything is relevant enough to answer from.
    """
    return get_vector_store().similarity_search_with_score(query, k=k)
