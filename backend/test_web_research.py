import json
import os
import unittest
from unittest.mock import patch

import httpx

import web_research


class WebResearchTests(unittest.TestCase):
    def test_only_current_information_questions_trigger_search(self):
        self.assertTrue(web_research.is_current_information_query("What is the latest news?"))
        self.assertTrue(web_research.is_current_information_query("What is the weather today?"))
        self.assertFalse(web_research.is_current_information_query("Explain evaporation."))

    def test_malformed_search_result_url_is_rejected(self):
        self.assertFalse(web_research._public_http_url("http://["))

    def test_search_returns_bounded_results_and_uses_crawled_content_if_available(self):
        result = {
            "title": "<b>Current science</b>",
            "url": "https://example.com/science",
            "content": "Search snippet",
        }

        class FakeResponse:
            content = b"{}"

            @staticmethod
            def raise_for_status():
                return None

            @staticmethod
            def json():
                return {"results": [result]}

        class FakeClient:
            def __init__(self, **_kwargs):
                self.request = None

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def get(self, url, *, params):
                self.request = (url, params)
                return FakeResponse()

        def fake_crawl(_results):
            return {result["url"]: "Crawled current science details"}

        with (
            patch.object(web_research.httpx, "Client", FakeClient),
            patch.object(
                web_research.socket,
                "getaddrinfo",
                return_value=[(None, None, None, None, ("93.184.216.34", 443))],
            ),
            patch.object(web_research, "_crawl_results", side_effect=fake_crawl),
        ):
            results = web_research.search_current_web("What is the latest science?")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["title"], "Current science")
        self.assertEqual(results[0]["excerpt"], "Crawled current science details")
        self.assertRegex(results[0]["retrieved_at"], r"^\d{4}-\d{2}-\d{2}$")

    def test_search_failure_returns_no_results_without_raising(self):
        with (
            patch.object(web_research.httpx, "Client", side_effect=httpx.ConnectError("offline")),
            self.assertLogs("web_research", level="WARNING"),
        ):
            self.assertEqual(web_research.search_current_web("What is happening today?"), [])

    def test_unavailable_crawl4ai_keeps_search_snippets(self):
        class FakeResponse:
            content = b"{}"

            @staticmethod
            def raise_for_status():
                return None

            @staticmethod
            def json():
                return {"results": [{
                    "title": "Current science",
                    "url": "https://example.com/science",
                    "content": "Search snippet",
                }]}

        class FakeClient:
            def __init__(self, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def get(self, _url, *, params):
                self.query = params["q"]
                return FakeResponse()

        with (
            patch.object(web_research.httpx, "Client", FakeClient),
            patch.object(
                web_research.socket,
                "getaddrinfo",
                return_value=[(None, None, None, None, ("93.184.216.34", 443))],
            ),
            patch.dict(os.environ, {}, clear=True),
        ):
            results = web_research.search_current_web("What is the latest science?")

        self.assertEqual(results[0]["excerpt"], "Search snippet")

    def test_authenticated_crawl_uses_bounded_page_config_and_extracts_markdown(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            @staticmethod
            def raise_for_status():
                return None

            @staticmethod
            def iter_bytes():
                return [json.dumps({
                    "results": [{
                        "success": True,
                        "markdown": {
                            "raw_markdown": "Full page text",
                            "fit_markdown": "",
                        },
                    }],
                }).encode()]

        class FakeClient:
            def __init__(self, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def stream(self, method, url, *, headers, json):
                captured.append((method, url, headers, json))
                return FakeResponse()

        captured = []
        with (
            patch.dict(os.environ, {"CRAWL4AI_API_TOKEN": "private-token"}),
            patch.object(web_research.httpx, "Client", FakeClient),
        ):
            result = web_research._crawl_results([
                {
                    "url": f"https://example.com/science/{index}",
                    "title": "Science",
                    "source": "example.com",
                    "excerpt": "Snippet",
                }
                for index in range(3)
            ])

        self.assertEqual(len(result), 2)
        self.assertEqual(len(captured), 2)
        method, url, headers, payload = captured[0]
        self.assertEqual(method, "POST")
        self.assertEqual(url, "http://127.0.0.1:11235/crawl")
        self.assertEqual(headers, {"Authorization": "Bearer private-token"})
        self.assertEqual(payload["urls"], ["https://example.com/science/0"])
        self.assertEqual(payload["crawler_config"]["page_timeout"], 3500)

    def test_missing_crawl_token_skips_optional_crawler(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(web_research.httpx, "Client") as client,
        ):
            self.assertEqual(web_research._crawl_results([{"url": "https://example.com"}]), {})
        client.assert_not_called()

    def test_crawl_http_failure_falls_back_to_search_snippets(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            @staticmethod
            def raise_for_status():
                raise httpx.HTTPStatusError(
                    "unauthorized",
                    request=httpx.Request("POST", "http://127.0.0.1:11235/crawl"),
                    response=httpx.Response(401),
                )

        class FakeClient:
            def __init__(self, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def stream(self, *_args, **_kwargs):
                return FakeResponse()

        with (
            patch.dict(os.environ, {"CRAWL4AI_API_TOKEN": "private-token"}),
            patch.object(web_research.httpx, "Client", FakeClient),
        ):
            result = web_research._crawl_results([{"url": "https://example.com"}])
        self.assertEqual(result, {})

    def test_oversized_crawl_response_is_discarded(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            @staticmethod
            def raise_for_status():
                return None

            @staticmethod
            def iter_bytes():
                return [b"x" * (web_research.MAX_CRAWL_RESPONSE_BYTES + 1)]

        class FakeClient:
            def __init__(self, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def stream(self, *_args, **_kwargs):
                return FakeResponse()

        with (
            patch.dict(os.environ, {"CRAWL4AI_API_TOKEN": "private-token"}),
            patch.object(web_research.httpx, "Client", FakeClient),
        ):
            result = web_research._crawl_results([{"url": "https://example.com"}])
        self.assertEqual(result, {})

    def test_crawl_network_failure_preserves_search_snippet(self):
        class SearchResponse:
            content = b"{}"

            @staticmethod
            def raise_for_status():
                return None

            @staticmethod
            def json():
                return {"results": [{
                    "title": "Current science",
                    "url": "https://example.com/science",
                    "content": "Search snippet",
                }]}

        class FakeClient:
            def __init__(self, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def get(self, *_args, **_kwargs):
                return SearchResponse()

            def stream(self, *_args, **_kwargs):
                raise httpx.ConnectError(
                    "offline",
                    request=httpx.Request("POST", "http://127.0.0.1:11235/crawl"),
                )

        with (
            patch.dict(os.environ, {"CRAWL4AI_API_TOKEN": "private-token"}),
            patch.object(web_research.httpx, "Client", FakeClient),
            patch.object(
                web_research.socket,
                "getaddrinfo",
                return_value=[(None, None, None, None, ("93.184.216.34", 443))],
            ),
        ):
            results = web_research.search_current_web("What is the latest science?")
        self.assertEqual(results[0]["excerpt"], "Search snippet")

    def test_non_current_question_does_not_contact_searxng(self):
        with patch.object(web_research.httpx, "Client") as client:
            self.assertEqual(web_research.search_current_web("Explain evaporation."), [])
        client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
