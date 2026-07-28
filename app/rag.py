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

# 1536-dim, inexpensive, plenty for a small knowledge base.
EMBEDDING_MODEL = "text-embedding-3-small"


def collection_name(tenant_id: str) -> str:
    """One pgvector collection per persona — that IS the knowledge isolation.

    The pgvector tables are library-managed (no tenant_id column, so not under RLS),
    so isolation here comes from never letting one tenant's retrieval touch another's
    collection. Keep this the single source of the naming so ingest and retrieval can't
    drift apart.
    """
    return f"tenant_{tenant_id}"


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


def build_store(tenant_id: str, pre_delete: bool = False) -> PGVector:
    """Construct the pgvector store for one persona's collection.

    pre_delete=True wipes the collection first — used by ingestion so re-running a
    source doesn't pile up duplicate chunks. `create_extension=True` runs
    `CREATE EXTENSION IF NOT EXISTS vector` on first use (Supabase permits this).
    """
    return PGVector(
        embeddings=get_embeddings(),
        connection=_sqlalchemy_url(),
        collection_name=collection_name(tenant_id),
        use_jsonb=True,
        create_extension=True,
        pre_delete_collection=pre_delete,
    )


@lru_cache
def get_vector_store(tenant_id: str) -> PGVector:
    """Shared, read-side store per persona (one engine reused across requests)."""
    return build_store(tenant_id, pre_delete=False)


def retrieve(query: str, *, tenant_id: str, k: int = 4) -> list[tuple[Document, float]]:
    """Return the k most similar chunks from THIS persona's collection.

    Distance is cosine distance: LOWER means MORE similar. The caller applies a
    threshold to decide whether anything is relevant enough to answer from.
    """
    return get_vector_store(tenant_id).similarity_search_with_score(query, k=k)
