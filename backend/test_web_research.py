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

        async def fake_crawl(_results):
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
            patch.object(web_research, "_crawl_results", side_effect=ImportError("optional package missing")),
        ):
            results = web_research.search_current_web("What is the latest science?")

        self.assertEqual(results[0]["excerpt"], "Search snippet")

    def test_non_current_question_does_not_contact_searxng(self):
        with patch.object(web_research.httpx, "Client") as client:
            self.assertEqual(web_research.search_current_web("Explain evaporation."), [])
        client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
