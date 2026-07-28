"""Per-persona knowledge ingestion — uploads and deep website crawls.

A persona learns from two source kinds, both landing in the same pgvector collection
(see app/rag.py) so retrieval treats them uniformly:

  * upload  — a document's text, chunked and embedded.
  * website — a DEEP crawl: start from the given URL(s), follow same-domain links
              breadth-first up to a page cap, extract readable text per page, and embed
              each page as its own citable source.

Ingestion is slow (a crawl hits many pages and embeds them), so callers run it as a
background task and watch the `knowledge_sources.status`/`page_count` columns for
progress. Everything writes under the tenant's scoped connection, so RLS keeps a
persona's knowledge rows its own.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from urllib.parse import urldefrag, urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.rag import build_store
from app.tenancy import scoped_connection

logger = logging.getLogger("replyo.knowledge")

# Chunking — small enough to be a precise citation, big enough to keep context.
CHUNK_SIZE = 800
CHUNK_OVERLAP = 100

# Crawl bounds. ~50 pages covers a typical small-business site fully in well under a
# minute; the cap is what stops a large or looping site from running away or running up
# embedding cost. User-supplied "important" URLs are always crawled first, so key deep
# pages are reached even when the cap bites.
MAX_PAGES = 50
CRAWL_TIMEOUT = 15  # seconds per page
USER_AGENT = "ReplyoBot/1.0 (+https://replyo.app/bot)"

_splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)


# ---------------------------------------------------------------------------
# status tracking
# ---------------------------------------------------------------------------

async def _set_status(tenant_id: str, source_id: str, status: str, **fields) -> None:
    sets = ["status = %s"]
    params: list = [status]
    for col, val in fields.items():
        sets.append(f"{col} = %s")
        params.append(val)
    params += [source_id]
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        await conn.execute(
            f"update knowledge_sources set {', '.join(sets)} where id = %s", tuple(params)
        )


# ---------------------------------------------------------------------------
# website crawl
# ---------------------------------------------------------------------------

def _normalize(url: str) -> str:
    """Drop the fragment + trailing slash so the same page isn't crawled twice."""
    url, _ = urldefrag(url)
    if url.endswith("/") and urlparse(url).path not in ("", "/"):
        url = url[:-1]
    return url


def _same_site(a: str, b: str) -> bool:
    return urlparse(a).netloc.lower() == urlparse(b).netloc.lower()


def _extract_text(soup: BeautifulSoup) -> str:
    """Readable text only — drop chrome that would just add noise to the embeddings."""
    for tag in soup(["script", "style", "nav", "footer", "header", "noscript", "svg", "form"]):
        tag.decompose()
    return " ".join(soup.get_text(" ", strip=True).split())


async def _load_robots(client: httpx.AsyncClient, start_url: str) -> RobotFileParser:
    rp = RobotFileParser()
    parsed = urlparse(start_url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    try:
        resp = await client.get(robots_url, timeout=CRAWL_TIMEOUT)
        rp.parse(resp.text.splitlines() if resp.status_code == 200 else [])
    except Exception:
        rp.parse([])  # unreachable robots -> allow (common for small sites)
    return rp


async def crawl(start_url: str, *, extra_urls: tuple[str, ...] = (), max_pages: int = MAX_PAGES):
    """Breadth-first, same-domain crawl. Returns [(url, title, text)] for pages with text."""
    seen: set[str] = set()
    # User-supplied important URLs first, then the entry point.
    queue: list[str] = [*extra_urls, start_url]
    pages: list[tuple[str, str, str]] = []

    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        robots = await _load_robots(client, start_url)

        while queue and len(pages) < max_pages:
            url = _normalize(queue.pop(0))
            if url in seen:
                continue
            seen.add(url)
            if not robots.can_fetch(USER_AGENT, url):
                continue
            try:
                resp = await client.get(url, timeout=CRAWL_TIMEOUT)
            except Exception:
                continue
            ctype = resp.headers.get("content-type", "")
            if resp.status_code != 200 or "html" not in ctype:
                continue

            soup = BeautifulSoup(resp.text, "html.parser")
            text = _extract_text(soup)
            title = (soup.title.string.strip() if soup.title and soup.title.string else url)
            if text.strip():
                pages.append((url, title, text))

            # Enqueue same-site links we haven't seen.
            for a in soup.find_all("a", href=True):
                link = _normalize(urljoin(url, a["href"]))
                if link not in seen and _same_site(link, start_url) and link.startswith("http"):
                    queue.append(link)

            await asyncio.sleep(0.1)  # be polite

    return pages


# ---------------------------------------------------------------------------
# ingestion entry points (run as background tasks)
# ---------------------------------------------------------------------------

async def ingest_upload(*, tenant_id: str, source_id: str, name: str, text: str) -> None:
    """Chunk + embed an uploaded document into the persona's collection."""
    try:
        await _set_status(tenant_id, source_id, "ingesting")
        docs = [
            Document(page_content=chunk, metadata={"source": name})
            for chunk in _splitter.split_text(text)
        ]
        build_store(tenant_id).add_documents(docs)
        await _set_status(
            tenant_id, source_id, "ready",
            chunk_count=len(docs), page_count=1,
            last_ingested_at=datetime.now(timezone.utc),
        )
        logger.info("Ingested upload %s (%d chunks) for tenant %s", name, len(docs), tenant_id)
    except Exception as exc:
        logger.exception("Upload ingest failed for %s", source_id)
        await _set_status(tenant_id, source_id, "error", error=str(exc)[:500])


async def ingest_website(
    *, tenant_id: str, source_id: str, url: str, extra_urls: tuple[str, ...] = ()
) -> None:
    """Deep-crawl a site and embed each page as its own citable source."""
    try:
        await _set_status(tenant_id, source_id, "ingesting")
        pages = await crawl(url, extra_urls=extra_urls)
        docs: list[Document] = []
        for page_url, title, text in pages:
            for chunk in _splitter.split_text(text):
                docs.append(Document(page_content=chunk, metadata={"source": title, "url": page_url}))
            # cheap progress signal for the dashboard's live counter
            await _set_status(tenant_id, source_id, "ingesting", page_count=len(pages))
        if docs:
            build_store(tenant_id).add_documents(docs)
        await _set_status(
            tenant_id, source_id, "ready",
            page_count=len(pages), chunk_count=len(docs),
            last_ingested_at=datetime.now(timezone.utc),
        )
        logger.info(
            "Crawled %s: %d pages -> %d chunks for tenant %s", url, len(pages), len(docs), tenant_id
        )
    except Exception as exc:
        logger.exception("Website ingest failed for %s", source_id)
        await _set_status(tenant_id, source_id, "error", error=str(exc)[:500])
