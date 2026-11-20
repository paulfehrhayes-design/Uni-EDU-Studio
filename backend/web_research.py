"""Optional live web research for current-information questions."""

from __future__ import annotations

import asyncio
import html
import ipaddress
import logging
import os
import re
import socket
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx

DEFAULT_SEARXNG_URL = "http://127.0.0.1:8080"
MAX_RESULTS = 3
MAX_EXCERPT_CHARS = 2_000
MAX_QUERY_CHARS = 500
SEARXNG_TIMEOUT = httpx.Timeout(connect=1.5, read=3, write=2, pool=1)

logger = logging.getLogger(__name__)

CURRENT_INFORMATION_TERMS = re.compile(
    r"\b(?:current(?:ly)?|latest|newest|recent(?:ly)?|today|tonight|"
    r"this\s+(?:week|month|year)|right\s+now|as\s+of|up[- ]to[- ]date|"
    r"live|breaking|news|weather|forecast|price|stock|exchange\s+rate|"
    r"score|results|schedule|election|who\s+is\s+the\s+current)\b",
    re.IGNORECASE,
)


def is_current_information_query(text: str) -> bool:
    return bool(CURRENT_INFORMATION_TERMS.search(text))


def _searxng_endpoint() -> str:
    configured = os.environ.get("HARRY_BOTTER_SEARXNG_URL", DEFAULT_SEARXNG_URL).rstrip("/")
    parsed = urlsplit(configured)
    if (
        parsed.scheme != "http"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise ValueError("SearXNG must use a plain HTTP URL with no path or credentials.")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError("SearXNG URL contains an invalid port.") from exc
    if parsed.hostname.casefold() != "localhost":
        try:
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError as exc:
            raise ValueError("SearXNG URL must use localhost or a private IP address.") from exc
        if not (address.is_loopback or address.is_private):
            raise ValueError("SearXNG URL must use localhost or a private IP address.")
    return configured


def _plain_text(value: object, max_chars: int = MAX_EXCERPT_CHARS) -> str:
    if not isinstance(value, str):
        return ""
    text = re.sub(r"<[^>]*>", " ", html.unescape(value))
    return " ".join(text.split())[:max_chars]


def _public_http_url(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
        ):
            return False
        parsed.port
        try:
            addresses = [ipaddress.ip_address(parsed.hostname)]
        except ValueError:
            addresses = [
                ipaddress.ip_address(item[4][0])
                for item in socket.getaddrinfo(
                    parsed.hostname,
                    parsed.port or (443 if parsed.scheme == "https" else 80),
                    type=socket.SOCK_STREAM,
                )
            ]
    except (OSError, ValueError):
        return False
    return bool(addresses) and all(address.is_global for address in addresses)


async def _crawl_results(results: list[dict[str, str]]) -> dict[str, str]:
    from crawl4ai import AsyncWebCrawler

    extracted: dict[str, str] = {}
    async with AsyncWebCrawler() as crawler:
        for item in results[:2]:
            try:
                page = await asyncio.wait_for(
                    crawler.arun(url=item["url"]),
                    timeout=5,
                )
            except (asyncio.TimeoutError, OSError, RuntimeError) as exc:
                logger.warning("Crawl4AI could not crawl a search result: %s", exc)
                continue
            markdown = getattr(page, "markdown", "")
            text = _plain_text(markdown)
            if getattr(page, "success", False) and text:
                extracted[item["url"]] = text
    return extracted


def search_current_web(text: str) -> list[dict[str, str]]:
    """Return bounded SearXNG results; live-search failures never block chat."""
    if not is_current_information_query(text):
        return []
    try:
        endpoint = _searxng_endpoint()
        with httpx.Client(timeout=SEARXNG_TIMEOUT, trust_env=False) as client:
            response = client.get(
                f"{endpoint}/search",
                params={"q": text[:MAX_QUERY_CHARS], "format": "json"},
            )
            response.raise_for_status()
            if len(response.content) > 1_000_000:
                raise ValueError("SearXNG response exceeded the size limit.")
            payload = response.json()
    except (httpx.RequestError, ValueError) as exc:
        logger.warning("Live web search is unavailable; continuing without web results: %s", exc)
        return []

    raw_results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(raw_results, list):
        logger.warning("Live web search returned an invalid result list; continuing without web results.")
        return []

    results = []
    for item in raw_results:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        title = _plain_text(item.get("title"), 160)
        excerpt = _plain_text(item.get("content"))
        if not title or not excerpt or not _public_http_url(url):
            continue
        results.append(
            {
                "title": title,
                "source": urlsplit(url).hostname or "",
                "url": url,
                "excerpt": excerpt,
            }
        )
        if len(results) >= MAX_RESULTS:
            break
    if not results:
        return []

    try:
        crawled = asyncio.run(asyncio.wait_for(_crawl_results(results), timeout=8))
    except (ImportError, asyncio.TimeoutError, OSError, RuntimeError) as exc:
        logger.info("Crawl4AI enrichment is unavailable; using search snippets: %s", exc)
        crawled = {}
    except Exception as exc:
        logger.warning("Crawl4AI enrichment failed; using search snippets: %s", exc)
        crawled = {}

    retrieved_date = datetime.now(timezone.utc).date().isoformat()
    return [
        {
            **item,
            "excerpt": crawled.get(item["url"], item["excerpt"]),
            "retrieved_at": retrieved_date,
        }
        for item in results
    ]
