"""LLM inference via a local Ollama server, using the native /api/chat endpoint."""

from collections.abc import Generator

import httpx
import ollama


class OllamaClient:
    def __init__(self, model: str, base_url: str, temperature: float | None = None) -> None:
        self.model = model
        self.base_url = base_url
        self.temperature = temperature
        self._client = ollama.Client(host=base_url)

    def stream_chat(self, messages: list[dict[str, str]]) -> Generator[str, None, None]:
        """Stream an assistant reply for the given messages, one token/chunk at a time."""
        kwargs = {}
        if self.temperature is not None:
            kwargs["options"] = {"temperature": self.temperature}
        try:
            for chunk in self._client.chat(model=self.model, messages=messages, stream=True, **kwargs):
                content = chunk["message"]["content"]
                if content:
                    yield content
        except httpx.ConnectError as exc:
            raise ConnectionError(
                f"Could not reach Ollama at {self.base_url}. Is `ollama serve` running?"
            ) from exc
