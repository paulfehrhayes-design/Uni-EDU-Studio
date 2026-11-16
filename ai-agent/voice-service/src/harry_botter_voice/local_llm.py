"""Local-only OpenAI-compatible model client."""

import ipaddress
import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from .prompts import MISSING_STAGE_RESPONSE, build_system_prompt


class LocalModelError(RuntimeError):
    """Raised when a configured local model endpoint returns unusable data."""


class LocalModelUnavailable(LocalModelError):
    """Raised when the local model endpoint cannot be reached."""


class LocalModelNotConfigured(LocalModelError):
    """Raised when no local model name has been configured."""


MAX_COMPLETION_CHARS = 12_000


class LocalOpenAIClient:
    def __init__(
        self,
        base_url: str | None = None,
        model: str | None = None,
        network_base_url: str | None = None,
        network_model: str | None = None,
        timeout_seconds: float = 60.0,
    ) -> None:
        self.base_url = (
            base_url
            if base_url is not None
            else os.environ.get(
                "HARRY_BOTTER_LOCAL_MODEL_URL",
                "http://127.0.0.1:11434/v1",
            )
        ).rstrip("/")
        self.model = (
            model if model is not None else os.environ.get("HARRY_BOTTER_LOCAL_MODEL", "")
        ).strip()
        configured_network_url = (
            network_base_url
            if network_base_url is not None
            else os.environ.get("HARRY_BOTTER_NETWORK_MODEL_URL", "")
        )
        self.network_base_url = configured_network_url.rstrip("/")
        self.network_model = (
            network_model
            if network_model is not None
            else os.environ.get("HARRY_BOTTER_NETWORK_MODEL", "")
        ).strip()
        self.timeout_seconds = timeout_seconds
        self._validate_base_url()
        if self.network_base_url or self.network_model:
            if not self.network_base_url or not self.network_model:
                raise ValueError(
                    "Configure both HARRY_BOTTER_NETWORK_MODEL_URL and "
                    "HARRY_BOTTER_NETWORK_MODEL."
                )
            self._validate_network_base_url()
        self._opener = build_opener(ProxyHandler({}))

    @property
    def is_configured(self) -> bool:
        return bool(self.model or self.network_model)

    def _targets(self) -> list[tuple[str, str, str]]:
        targets = []
        if self.network_model:
            targets.append(("network", self.network_base_url, self.network_model))
        if self.model:
            targets.append(("local", self.base_url, self.model))
        return targets

    def status(self) -> dict[str, str | bool]:
        if not self.is_configured:
            return {
                "status": "not_configured",
                "configured": False,
                "provider": "local_openai_compatible",
                "model": "",
            }

        errors: list[str] = []
        missing_models: list[tuple[str, str]] = []
        for route, base_url, model in self._targets():
            try:
                response = self._request_json("GET", "models", base_url=base_url)
            except LocalModelUnavailable as exc:
                errors.append(str(exc))
                continue

            models = response.get("data")
            if not isinstance(models, list):
                raise LocalModelError("Model server returned an invalid models response.")
            available_models = [
                item.get("id")
                for item in models
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            ]
            if model in available_models:
                result: dict[str, str | bool] = {
                    "status": "ready",
                    "configured": True,
                    "provider": "ollama_lan" if route == "network" else "ollama_local",
                    "route": route,
                    "model": model,
                }
                if route == "local" and self.network_model:
                    result["fallback"] = "The configured Wi-Fi model is unavailable."
                return result
            missing_models.append((route, model))

        if missing_models:
            route, model = missing_models[-1]
            return {
                "status": "model_missing",
                "configured": True,
                "provider": "ollama_lan" if route == "network" else "ollama_local",
                "route": route,
                "model": model,
                "error": errors[-1] if errors else "",
            }
        return {
            "status": "unavailable",
            "configured": True,
            "provider": "local_openai_compatible",
            "model": self.network_model or self.model,
            "error": errors[-1] if errors else "No configured model server is available.",
        }

    def complete(
        self,
        text: str,
        learning_level: str,
        tone: str,
        history: list[dict[str, str]],
        agent: dict | None = None,
        knowledge: list[dict] | None = None,
    ) -> str:
        answer, _, _ = self.complete_with_route(
            text, learning_level, tone, history, agent, knowledge
        )
        return answer

    def complete_with_route(
        self,
        text: str,
        learning_level: str,
        tone: str,
        history: list[dict[str, str]],
        agent: dict | None = None,
        knowledge: list[dict] | None = None,
    ) -> tuple[str, str, str]:
        if not learning_level:
            return MISSING_STAGE_RESPONSE, "", "stage_policy"
        targets = self._targets()
        if not targets:
            raise LocalModelNotConfigured(
                "No local model is configured. Set HARRY_BOTTER_LOCAL_MODEL."
            )

        messages = [
            {
                "role": "system",
                "content": build_system_prompt(learning_level, tone, agent, knowledge),
            },
            *history,
            {"role": "user", "content": text},
        ]
        generation_temperature = (
            agent.get("generation_temperature", 0.4) if agent else 0.4
        )
        generation_max_tokens = agent.get("generation_max_tokens", 500) if agent else 500
        errors = []
        for route, base_url, model in targets:
            try:
                response = self._request_json(
                    "POST",
                    "chat/completions",
                    {
                        "model": model,
                        "messages": messages,
                        "temperature": generation_temperature,
                        "max_tokens": generation_max_tokens,
                        "stream": False,
                    },
                    base_url=base_url,
                )
            except LocalModelUnavailable as exc:
                errors.append(exc)
                continue
            choices = response.get("choices")
            if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
                raise LocalModelError("Model server returned no chat completion.")
            message = choices[0].get("message")
            if not isinstance(message, dict) or not isinstance(message.get("content"), str):
                raise LocalModelError("Model server returned an invalid chat completion.")
            completion = message["content"].strip()
            if not completion:
                raise LocalModelError("Model server returned an empty chat completion.")
            if len(completion) > MAX_COMPLETION_CHARS:
                raise LocalModelError("Model completion exceeded the size limit.")
            return completion, model, route
        if errors:
            raise LocalModelUnavailable(str(errors[-1])) from errors[-1]
        raise LocalModelUnavailable("No configured model server is available.")

    def _validate_base_url(self) -> None:
        parsed = urlsplit(self.base_url)
        if (
            parsed.scheme != "http"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("The local model URL must be a plain HTTP loopback URL.")
        try:
            parsed.port
        except ValueError as exc:
            raise ValueError("The local model URL contains an invalid port.") from exc
        if parsed.hostname.casefold() != "localhost":
            try:
                address = ipaddress.ip_address(parsed.hostname)
            except ValueError as exc:
                raise ValueError("The local model URL must use a loopback host.") from exc
            if not address.is_loopback:
                raise ValueError("The local model URL must use a loopback host.")

    def _validate_network_base_url(self) -> None:
        parsed = urlsplit(self.network_base_url)
        if (
            parsed.scheme != "http"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("The Wi-Fi model URL must be plain HTTP on a private-network IP.")
        try:
            parsed.port
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError as exc:
            raise ValueError(
                "The Wi-Fi model URL must use a private-network IP address and valid port."
            ) from exc
        if (
            not address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
        ):
            raise ValueError("The Wi-Fi model URL must use a private-network IP address.")

    def _request_json(
        self,
        method: str,
        path: str,
        payload: dict | None = None,
        base_url: str | None = None,
    ) -> dict:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(
            f"{(base_url or self.base_url)}/{path}",
            data=data,
            headers={"Content-Type": "application/json"} if data is not None else {},
            method=method,
        )
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                body = response.read(2_000_001)
        except HTTPError as exc:
            raise LocalModelUnavailable(
                f"Model server returned HTTP {exc.code}."
            ) from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise LocalModelUnavailable(
                "Could not reach the configured model server."
            ) from exc

        if len(body) > 2_000_000:
            raise LocalModelError("Model server response exceeded the size limit.")
        try:
            result = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise LocalModelError("Model server returned invalid JSON.") from exc
        if not isinstance(result, dict):
            raise LocalModelError("Model server returned an invalid response.")
        return result
