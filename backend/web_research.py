"""Optional live web research for current-information questions."""

from __future__ import annotations

import html
import ipaddress
import json
import logging
import os
import re
import socket
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx

DEFAULT_SEARXNG_URL = "http://127.0.0.1:8080"
DEFAULT_CRAWL4AI_URL = "http://127.0.0.1:11235"
MAX_RESULTS = 3
MAX_EXCERPT_CHARS = 2_000
MAX_QUERY_CHARS = 500
MAX_CRAWL_RESPONSE_BYTES = 1_000_000
SEARXNG_TIMEOUT = httpx.Timeout(connect=1.5, read=3, write=2, pool=1)
CRAWL4AI_TIMEOUT = httpx.Timeout(connect=1.5, read=4, write=2, pool=1)

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


def _crawl_results(results: list[dict[str, str]]) -> dict[str, str]:
    token = os.environ.get("CRAWL4AI_API_TOKEN", "").strip()
    if not token:
        logger.info("Crawl4AI is not configured; using SearXNG snippets.")
        return {}
    extracted: dict[str, str] = {}
    with httpx.Client(timeout=CRAWL4AI_TIMEOUT, trust_env=False) as client:
        for item in results[:2]:
            try:
                body = bytearray()
                with client.stream(
                    "POST",
                    f"{DEFAULT_CRAWL4AI_URL}/crawl",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "urls": [item["url"]],
                        "crawler_config": {
                            "cache_mode": "bypass",
                            "page_timeout": 3500,
                            "word_count_threshold": 0,
                        },
                    },
                ) as response:
                    response.raise_for_status()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_CRAWL_RESPONSE_BYTES:
                            raise ValueError("Crawl4AI response exceeded the size limit.")
                payload = json.loads(body)
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning(
                    "Crawl4AI enrichment failed; using the search snippet (%s).",
                    type(exc).__name__,
                )
                continue
            page_results = payload.get("results") if isinstance(payload, dict) else None
            page = page_results[0] if isinstance(page_results, list) and page_results else None
            if not isinstance(page, dict) or page.get("success") is not True:
                logger.info("Crawl4AI returned no usable page; using the search snippet.")
                continue
            markdown = page.get("markdown")
            if isinstance(markdown, dict):
                markdown = markdown.get("fit_markdown") or markdown.get("raw_markdown")
            text = _plain_text(markdown)
            if text:
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

    crawled = _crawl_results(results)

    retrieved_date = datetime.now(timezone.utc).date().isoformat()
    return [
        {
            **item,
            "excerpt": crawled.get(item["url"], item["excerpt"]),
            "retrieved_at": retrieved_date,
        }
        for item in results
    ]
