"""Loopback-only HTTP API for the initial voice service foundation."""

import ipaddress
import json
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

from . import __version__
from .prompts import MISSING_STAGE_RESPONSE
from .local_llm import (
    LocalModelError,
    LocalModelNotConfigured,
    LocalModelUnavailable,
    LocalOpenAIClient,
)
from .speech import (
    ALLOWED_AUDIO_TYPES,
    MAX_AUDIO_BYTES,
    MAX_SPEECH_CHARS,
    LocalSpeechRuntime,
    SpeechRuntimeError,
    SpeechRuntimeNotConfigured,
)
from .sessions import (
    InvalidSessionTransitionError,
    SessionManager,
    SessionNotFoundError,
)

MAX_REQUEST_BYTES = 64_000
MAX_MESSAGE_CHARS = 2_000
MAX_HISTORY_MESSAGES = 12
MAX_KNOWLEDGE_DOCUMENTS = 3
MAX_KNOWLEDGE_EXCERPT_CHARS = 2_500
LEARNING_LEVELS = {
    "Early Years",
    *(f"PYP {year}" for year in range(1, 6)),
    *(f"MYP {year}" for year in range(1, 6)),
    "DP 1",
    "DP 2",
}
TONES = {"Formal", "Lightly humorous"}


def _is_iso_date(value: str) -> bool:
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


class VoiceHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        request_handler: type[BaseHTTPRequestHandler],
        session_manager: SessionManager,
        model_client: LocalOpenAIClient,
        speech_runtime: LocalSpeechRuntime,
    ) -> None:
        self.session_manager = session_manager
        self.model_client = model_client
        self.speech_runtime = speech_runtime
        super().__init__(server_address, request_handler)


class VoiceRequestHandler(BaseHTTPRequestHandler):
    server: VoiceHTTPServer
    server_version = "HarryBotterVoice/0.1"
    sys_version = ""

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/v1/health":
            speech_status = self.server.speech_runtime.status()
            self._send_json(
                200,
                {
                    "status": "ok",
                    "api_version": "v1",
                    "service_version": __version__,
                    "capabilities": {
                        "audio_capture": speech_status.get("streaming_transcription", {}).get("available", False),
                        "transcription": speech_status["transcription"]["available"],
                        "diarization": speech_status.get("streaming_transcription", {}).get("diarization_available", False),
                        "llm": self.server.model_client.is_configured,
                        "text_to_speech": speech_status["speech_generation"]["available"],
                        "motion": False,
                    },
                },
            )
            return
        if path == "/api/v1/model/status":
            try:
                status = self.server.model_client.status()
            except LocalModelError as exc:
                self._send_error(502, "model_status_error", str(exc))
                return
            self._send_json(200, status)
            return
        if path == "/api/v1/speech/status":
            self._send_json(200, self.server.speech_runtime.status())
            return

        parts = path.strip("/").split("/")
        if len(parts) == 4 and parts[:3] == ["api", "v1", "sessions"]:
            self._get_session(parts[3])
            return

        self._send_error(404, "not_found", "The requested endpoint does not exist.")

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/v1/drafts":
            payload = self._read_json()
            if payload is not None:
                self._create_draft(payload)
            return
        if path == "/api/v1/transcribe":
            audio = self._read_audio()
            if audio is not None:
                self._transcribe(audio)
            return
        if path == "/api/v1/speech":
            payload = self._read_json()
            if payload is not None:
                self._synthesize(payload)
            return

        if not self._has_empty_body():
            return

        if path == "/api/v1/sessions":
            session = self.server.session_manager.create()
            self._send_json(201, {"session": session.to_dict()})
            return

        parts = path.strip("/").split("/")
        if len(parts) == 5 and parts[:3] == ["api", "v1", "sessions"]:
            self._transition_session(parts[3], parts[4])
            return

        self._send_error(404, "not_found", "The requested endpoint does not exist.")

    def do_DELETE(self) -> None:
        path = urlsplit(self.path).path
        parts = path.strip("/").split("/")
        if len(parts) == 4 and parts[:3] == ["api", "v1", "sessions"]:
            try:
                self.server.session_manager.delete(parts[3])
            except SessionNotFoundError:
                self._send_error(404, "session_not_found", "The session does not exist.")
                return
            self._send_json(200, {"deleted": True})
            return

        self._send_error(404, "not_found", "The requested endpoint does not exist.")

    def _get_session(self, session_id: str) -> None:
        try:
            session = self.server.session_manager.get(session_id)
        except SessionNotFoundError:
            self._send_error(404, "session_not_found", "The session does not exist.")
            return
        self._send_json(200, {"session": session.to_dict()})

    def _transition_session(self, session_id: str, action: str) -> None:
        transitions = {
            "start": self.server.session_manager.start,
            "stop": self.server.session_manager.stop,
        }
        transition = transitions.get(action)
        if transition is None:
            self._send_error(404, "not_found", "The requested endpoint does not exist.")
            return

        try:
            session = transition(session_id)
        except SessionNotFoundError:
            self._send_error(404, "session_not_found", "The session does not exist.")
            return
        except InvalidSessionTransitionError as exc:
            self._send_error(409, "invalid_session_state", str(exc))
            return
        self._send_json(200, {"session": session.to_dict()})

    def _create_draft(self, payload: dict[str, Any]) -> None:
        allowed_keys = {"text", "learning_level", "tone", "history", "agent", "knowledge"}
        if set(payload) - allowed_keys:
            self._send_error(400, "invalid_request", "The draft request contains unsupported fields.")
            return

        text = payload.get("text")
        learning_level = payload.get("learning_level", "")
        tone = payload.get("tone", "Formal")
        history = payload.get("history", [])
        agent = payload.get("agent")
        knowledge = payload.get("knowledge", [])
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_MESSAGE_CHARS:
            self._send_error(
                400,
                "invalid_text",
                f"Text must contain 1 to {MAX_MESSAGE_CHARS} characters.",
            )
            return
        if not isinstance(learning_level, str) or learning_level not in LEARNING_LEVELS | {""}:
            self._send_error(400, "invalid_learning_level", "Choose a supported IB programme and year.")
            return
        if not isinstance(tone, str) or tone not in TONES:
            self._send_error(400, "invalid_tone", "Choose a supported conversation tone.")
            return
        if not isinstance(history, list) or len(history) > MAX_HISTORY_MESSAGES:
            self._send_error(400, "invalid_history", "Conversation history exceeds the supported limit.")
            return
        if any(
            not isinstance(item, dict)
            or set(item) != {"role", "content"}
            or item.get("role") not in {"user", "assistant"}
            or not isinstance(item.get("content"), str)
            or not item["content"].strip()
            or len(item["content"]) > MAX_MESSAGE_CHARS
            for item in history
        ):
            self._send_error(
                400,
                "invalid_history",
                "History must contain only non-empty user and assistant messages.",
            )
            return
        if agent is not None and (
            not isinstance(agent, dict)
            or set(agent) != {
                "agent_id",
                "display_name",
                "purpose",
                "instructions",
                "generation_temperature",
                "generation_max_tokens",
            }
            or any(
                not isinstance(agent.get(key), str)
                or not agent[key].strip()
                or len(agent[key]) > limit
                for key, limit in (
                    ("agent_id", 80),
                    ("display_name", 80),
                    ("purpose", 500),
                    ("instructions", 5_000),
                )
            )
            or isinstance(agent.get("generation_temperature"), bool)
            or not isinstance(agent.get("generation_temperature"), (int, float))
            or not 0 <= agent["generation_temperature"] <= 1
            or isinstance(agent.get("generation_max_tokens"), bool)
            or not isinstance(agent.get("generation_max_tokens"), int)
            or not 64 <= agent["generation_max_tokens"] <= 1_000
        ):
            self._send_error(400, "invalid_agent", "The selected agent configuration is invalid.")
            return
        if not isinstance(knowledge, list) or len(knowledge) > MAX_KNOWLEDGE_DOCUMENTS:
            self._send_error(400, "invalid_knowledge", "Too many knowledge excerpts were provided.")
            return
        if any(
            not isinstance(item, dict)
            or set(item) != {"title", "source", "owner", "review_date", "excerpt"}
            or any(
                not isinstance(item.get(key), str)
                or not item[key].strip()
                or len(item[key]) > limit
                for key, limit in (
                    ("title", 160),
                    ("source", 500),
                    ("owner", 120),
                    ("excerpt", MAX_KNOWLEDGE_EXCERPT_CHARS),
                )
            )
            or not isinstance(item.get("review_date"), str)
            or len(item["review_date"]) != 10
            or not _is_iso_date(item["review_date"])
            for item in knowledge
        ):
            self._send_error(400, "invalid_knowledge", "A knowledge excerpt is invalid.")
            return

        if not learning_level:
            self._send_json(
                200,
                {
                    "draft": {
                        "text": MISSING_STAGE_RESPONSE,
                        "source": "stage_policy",
                        "model": None,
                    }
                },
            )
            return

        try:
            answer, model_name, route = self.server.model_client.complete_with_route(
                text.strip(),
                learning_level,
                tone,
                history,
                agent,
                knowledge,
            )
        except LocalModelNotConfigured as exc:
            self._send_error(503, "model_not_configured", str(exc))
            return
        except LocalModelUnavailable as exc:
            self._send_error(503, "model_unavailable", str(exc))
            return
        except LocalModelError as exc:
            self._send_error(502, "model_error", str(exc))
            return
        self._send_json(
            200,
            {
                "draft": {
                    "text": answer,
                    "source": "local_model",
                    "model": model_name,
                    "route": route,
                    "sources": [
                        {
                            "title": item["title"],
                            "source": item["source"],
                            "review_date": item["review_date"],
                        }
                        for item in knowledge
                    ],
                }
            },
        )

    def _transcribe(self, audio: tuple[bytes, str]) -> None:
        try:
            transcript = self.server.speech_runtime.transcribe(*audio)
        except ValueError as exc:
            self._send_error(400, "invalid_audio", str(exc))
            return
        except SpeechRuntimeNotConfigured as exc:
            self._send_error(503, "speech_not_configured", str(exc))
            return
        except SpeechRuntimeError as exc:
            self._send_error(502, "transcription_error", str(exc))
            return
        self._send_json(200, {"transcript": transcript, "model": self.server.speech_runtime.transcription_model})

    def _synthesize(self, payload: dict[str, Any]) -> None:
        if set(payload) - {"text", "speed"} or "text" not in payload:
            self._send_error(400, "invalid_request", "Speech requests must contain text and an optional speed.")
            return
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_SPEECH_CHARS:
            self._send_error(
                400,
                "invalid_text",
                f"Speech text must contain 1 to {MAX_SPEECH_CHARS} characters.",
            )
            return
        speed = payload.get("speed", 1.0)
        if (
            isinstance(speed, bool)
            or not isinstance(speed, (int, float))
            or not 0.75 <= speed <= 1.25
        ):
            self._send_error(400, "invalid_speed", "Speech speed must be between 0.75 and 1.25.")
            return
        try:
            audio = self.server.speech_runtime.synthesize(text, speed=float(speed))
        except SpeechRuntimeNotConfigured as exc:
            self._send_error(503, "speech_not_configured", str(exc))
            return
        except SpeechRuntimeError as exc:
            self._send_error(502, "speech_generation_error", str(exc))
            return
        self._send_bytes(200, "audio/wav", audio)

    def _read_audio(self) -> tuple[bytes, str] | None:
        if self.headers.get("Transfer-Encoding"):
            self._send_error(400, "invalid_request_body", "Chunked audio bodies are not supported.")
            return None
        content_type = self.headers.get_content_type()
        if content_type not in ALLOWED_AUDIO_TYPES:
            self._send_error(415, "unsupported_media_type", "Send WebM, Ogg, MP4, or WAV audio.")
            return None
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_error(400, "invalid_content_length", "Content-Length must be an integer.")
            return None
        if content_length <= 0:
            self._send_error(400, "empty_audio", "A non-empty audio recording is required.")
            return None
        if content_length > MAX_AUDIO_BYTES:
            self._send_error(413, "audio_too_large", "Audio recordings must be 8 MB or smaller.")
            return None
        audio = self.rfile.read(content_length)
        if len(audio) != content_length:
            self._send_error(400, "incomplete_audio", "The audio upload was incomplete.")
            return None
        return audio, content_type

    def _read_json(self) -> dict[str, Any] | None:
        if self.headers.get("Transfer-Encoding"):
            self._send_error(400, "invalid_request_body", "Chunked request bodies are not supported.")
            return None
        if self.headers.get_content_type() != "application/json":
            self._send_error(415, "unsupported_media_type", "Send a JSON request body.")
            return None
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_error(400, "invalid_content_length", "Content-Length must be an integer.")
            return None
        if content_length <= 0:
            self._send_error(400, "empty_request_body", "A JSON request body is required.")
            return None
        if content_length > MAX_REQUEST_BYTES:
            self._send_error(413, "request_too_large", "The draft request exceeds the size limit.")
            return None
        body = self.rfile.read(content_length)
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_error(400, "invalid_json", "The request body must be valid JSON.")
            return None
        if not isinstance(payload, dict):
            self._send_error(400, "invalid_request", "The request body must be a JSON object.")
            return None
        return payload

    def _has_empty_body(self) -> bool:
        if self.headers.get("Transfer-Encoding"):
            self._send_error(400, "request_body_not_supported", "Request bodies are not supported.")
            return False
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_error(400, "invalid_content_length", "Content-Length must be an integer.")
            return False
        if content_length != 0:
            self._send_error(400, "request_body_not_supported", "Request bodies are not supported.")
            return False
        return True

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status: int, code: str, message: str) -> None:
        self._send_json(status, {"error": {"code": code, "message": message}})

    def log_message(self, format: str, *args: object) -> None:
        super().log_message(format, *args)


def make_server(
    host: str = "127.0.0.1",
    port: int = 8765,
    session_manager: SessionManager | None = None,
    model_client: LocalOpenAIClient | None = None,
    speech_runtime: LocalSpeechRuntime | None = None,
) -> VoiceHTTPServer:
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise ValueError("The voice service must bind to an IPv4 loopback address.") from exc
    if not isinstance(address, ipaddress.IPv4Address) or not address.is_loopback:
        raise ValueError("The voice service must bind to an IPv4 loopback address.")

    return VoiceHTTPServer(
        (host, port),
        VoiceRequestHandler,
        session_manager or SessionManager(),
        model_client or LocalOpenAIClient(),
        speech_runtime or LocalSpeechRuntime(),
    )
