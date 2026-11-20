"""Loopback WebSocket transport and in-memory VAD-bounded speech turns."""

import json
import re
import threading
from collections import deque
from datetime import datetime, timezone
from typing import Any, Callable
import numpy as np

from .speech import (
    MAX_STREAM_UTTERANCE_BYTES,
    STREAM_SAMPLE_RATE,
    LocalSpeechRuntime,
    SpeechRuntimeError,
    SpeechRuntimeNotConfigured,
)

STREAM_SUBPROTOCOL = "harry-botter-audio-v1"
STREAM_FRAME_SAMPLES = 320
STREAM_FRAME_BYTES = STREAM_FRAME_SAMPLES * 2
PRE_ROLL_FRAMES = 10
VAD_START_WINDOW = 5
VAD_START_COUNT = 3
VAD_END_SILENCE_FRAMES = 15
MAX_UTTERANCE_FRAMES = MAX_STREAM_UTTERANCE_BYTES // STREAM_FRAME_BYTES
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,64}$")


class AdaptiveSpeakerTracker:
    """Session-local spectral speaker clustering, not identity recognition."""

    def __init__(self, similarity_threshold: float = 0.82) -> None:
        self.similarity_threshold = similarity_threshold
        self._profiles: list[dict[str, Any]] = []

    def _embedding(self, audio: bytes) -> np.ndarray | None:
        if len(audio) < STREAM_FRAME_BYTES * 20:
            return None
        samples = np.frombuffer(audio, dtype="<i2").astype(np.float32)
        samples -= np.mean(samples)
        if float(np.max(np.abs(samples))) < 1.0:
            return None
        window_count = min(120, max(1, len(samples) // STREAM_FRAME_BYTES))
        chunk = len(samples) // window_count
        chunks = [
            samples[index:index + chunk]
            for index in range(0, len(samples), chunk)
            if len(samples[index:index + chunk]) >= 256
        ]
        bins: list[np.ndarray] = []
        for frame in chunks[:60]:
            frame = frame[: min(len(frame), 4_096)]
            if len(frame) < 256:
                continue
            frame = frame * np.hanning(len(frame))
            spectrum = np.abs(np.fft.rfft(frame))
            groups = np.array_split(spectrum[: min(2048, len(spectrum))], 32)
            bins.append(np.log1p(np.concatenate([
                np.array([float(np.mean(group))]) for group in groups
            ])))
        if not bins:
            return None
        embedding = np.mean(np.stack(bins), axis=0)
        norm = float(np.linalg.norm(embedding))
        return embedding / norm if norm else None

    def identify(self, audio: bytes) -> tuple[str, float]:
        embedding = self._embedding(audio)
        if embedding is None:
            return "Speaker 1", 0.0
        best_index = -1
        best_similarity = -1.0
        for index, profile in enumerate(self._profiles):
            similarity = float(np.dot(embedding, profile["embedding"]))
            if similarity > best_similarity:
                best_similarity = similarity
                best_index = index
        if best_index >= 0 and best_similarity >= self.similarity_threshold:
            profile = self._profiles[best_index]
            profile["embedding"] = (
                profile["embedding"] * 0.8 + embedding * 0.2
            )
            profile["embedding"] /= np.linalg.norm(profile["embedding"])
            profile["samples"] += 1
            return profile["label"], max(0.0, min(1.0, best_similarity))
        index = len(self._profiles) + 1
        label = f"Speaker {index}"
        self._profiles.append({
            "label": label,
            "embedding": embedding,
            "samples": 1,
        })
        return label, 0.0


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class StreamingSpeechSession:
    def __init__(
        self,
        speech_runtime: LocalSpeechRuntime,
        vad: Any | None = None,
        adaptive_speakers: bool = False,
        current_speaker: str | None = None,
    ) -> None:
        if vad is None:
            try:
                import webrtcvad
            except ImportError as exc:
                raise SpeechRuntimeNotConfigured(
                    "Streaming voice activity detection is not installed. Install the audio extra."
                ) from exc
            vad = webrtcvad.Vad(2)
        self._speech_runtime = speech_runtime
        self._vad = vad
        self._session_id = ""
        self._sequence = 0
        self._recent_frames: deque[tuple[bytes, bool]] = deque(maxlen=VAD_START_WINDOW)
        self._pre_roll: deque[bytes] = deque(maxlen=PRE_ROLL_FRAMES)
        self._utterance_frames: list[bytes] = []
        self._active = False
        self._quiet_frames = 0
        self._adaptive_speakers = adaptive_speakers
        self._current_speaker = current_speaker
        self._speaker_tracker = AdaptiveSpeakerTracker()

    def start(self, session_id: str) -> None:
        if not SESSION_ID_PATTERN.fullmatch(session_id):
            raise ValueError("The voice session identifier is invalid.")
        self._session_id = session_id

    def feed(self, frame: bytes) -> list[dict[str, Any]]:
        if not self._session_id:
            raise ValueError("Start a voice session before sending audio.")
        if len(frame) != STREAM_FRAME_BYTES:
            raise ValueError("Audio frames must contain 20 ms of 16 kHz mono PCM.")
        is_speech = self._vad.is_speech(frame, STREAM_SAMPLE_RATE)
        if not self._active:
            self._pre_roll.append(frame)
            self._recent_frames.append((frame, is_speech))
            if sum(1 for _, speech in self._recent_frames if speech) < VAD_START_COUNT:
                return []
            self._active = True
            self._utterance_frames = list(self._pre_roll)
            self._quiet_frames = 0
            return [self._event("speech_started")]

        self._utterance_frames.append(frame)
        self._quiet_frames = 0 if is_speech else self._quiet_frames + 1
        if (
            self._quiet_frames >= VAD_END_SILENCE_FRAMES
            or len(self._utterance_frames) >= MAX_UTTERANCE_FRAMES
        ):
            return self._finish_utterance()
        return []

    def finish(self) -> list[dict[str, Any]]:
        return self._finish_utterance() if self._active else []

    def _finish_utterance(self) -> list[dict[str, Any]]:
        if not self._active:
            return []
        audio = b"".join(self._utterance_frames)
        self._active = False
        self._quiet_frames = 0
        self._utterance_frames.clear()
        self._pre_roll.clear()
        self._recent_frames.clear()
        try:
            transcript = self._speech_runtime.transcribe_pcm(audio)
        except SpeechRuntimeError as exc:
            return [
                self._event("error", code="transcription_error", message=str(exc)),
                self._event("speech_ended"),
            ]
        events = []
        if transcript:
            speaker = None
            confidence = None
            if self._adaptive_speakers:
                if self._current_speaker:
                    speaker = self._current_speaker
                    confidence = 1.0
                else:
                    speaker, confidence = self._speaker_tracker.identify(audio)
            events.append(
                self._event(
                    "transcript_final",
                    text=transcript,
                    speaker=speaker,
                    speaker_confidence=confidence,
                    diarization_available=self._adaptive_speakers,
                )
            )
        else:
            events.append(self._event("speech_not_recognized"))
        events.append(self._event("speech_ended"))
        return events

    def _event(self, event_type: str, **values: Any) -> dict[str, Any]:
        self._sequence += 1
        return {
            "type": event_type,
            "session_id": self._session_id,
            "sequence": self._sequence,
            "timestamp": _utc_timestamp(),
            **values,
        }


def make_audio_stream_handler(
    speech_runtime: LocalSpeechRuntime,
    vad_factory: Callable[[], Any] | None = None,
):
    def handle(connection) -> None:
        from websockets.exceptions import ConnectionClosed

        try:
            handle_connection(connection)
        except ConnectionClosed:
            return

    def handle_connection(connection) -> None:
        if connection.request.path != "/api/v1/audio-stream":
            connection.close(code=1008, reason="The audio stream path is not supported.")
            return
        if connection.request.headers.get("Origin"):
            connection.close(code=1008, reason="Use the authenticated application audio proxy.")
            return
        if connection.subprotocol != STREAM_SUBPROTOCOL:
            connection.close(code=1008, reason="The audio stream protocol is not supported.")
            return
        try:
            start_payload = json.loads(connection.recv(timeout=5))
            if (
                not isinstance(start_payload, dict)
                or start_payload.keys() - {
                    "type",
                    "session_id",
                    "sample_rate",
                    "format",
                    "participant_mode",
                    "current_speaker",
                    "speaker_assignment_mode",
                }
                or not {"type", "session_id", "sample_rate", "format"} <= start_payload.keys()
                or start_payload["type"] != "start"
                or start_payload["sample_rate"] != STREAM_SAMPLE_RATE
                or start_payload["format"] != "pcm_s16le_mono"
            ):
                raise ValueError("The audio stream start message is invalid.")
            session = StreamingSpeechSession(
                speech_runtime,
                vad=vad_factory() if vad_factory is not None else None,
                adaptive_speakers=(
                    start_payload.get("participant_mode") == "group"
                    and start_payload.get("speaker_assignment_mode") == "adaptive"
                ),
                current_speaker=(
                    start_payload.get("current_speaker")
                    if start_payload.get("speaker_assignment_mode") == "selected"
                    else None
                ),
            )
            session.start(start_payload["session_id"])
        except SpeechRuntimeNotConfigured as exc:
            connection.send(
                json.dumps({
                    "type": "error",
                    "code": "stream_not_configured",
                    "message": str(exc),
                })
            )
            connection.close(code=1011, reason="Local streaming dependencies are unavailable.")
            return
        except (TimeoutError, json.JSONDecodeError, TypeError, ValueError) as exc:
            connection.send(
                json.dumps(
                    {
                        "type": "error",
                        "code": "invalid_stream_start",
                        "message": str(exc),
                    }
                )
            )
            connection.close(code=1008, reason="Invalid audio stream start message.")
            return

        connection.send(
            json.dumps(
                {
                    "type": "ready",
                    "session_id": start_payload["session_id"],
                    "sample_rate": STREAM_SAMPLE_RATE,
                    "frame_samples": STREAM_FRAME_SAMPLES,
                }
            )
        )
        for message in connection:
            if isinstance(message, str):
                try:
                    control = json.loads(message)
                except json.JSONDecodeError:
                    connection.close(code=1003, reason="Expected a valid audio control message.")
                    return
                if control == {"type": "stop"}:
                    for event in session.finish():
                        connection.send(json.dumps(event))
                    connection.send(json.dumps({"type": "stopped", "session_id": start_payload["session_id"]}))
                    return
                connection.close(code=1008, reason="Unsupported audio stream control message.")
                return
            try:
                events = session.feed(message)
            except ValueError as exc:
                connection.send(json.dumps({"type": "error", "code": "invalid_audio_frame", "message": str(exc)}))
                connection.close(code=1003, reason="Invalid audio frame.")
                return
            for event in events:
                connection.send(json.dumps(event))

    return handle


def start_audio_stream_server(
    speech_runtime: LocalSpeechRuntime,
    host: str = "127.0.0.1",
    port: int = 8766,
    vad_factory: Callable[[], Any] | None = None,
):
    from websockets.sync.server import serve

    server = serve(
        make_audio_stream_handler(speech_runtime, vad_factory),
        host,
        port,
        subprotocols=[STREAM_SUBPROTOCOL],
        compression=None,
        max_size=16_000,
        max_queue=8,
    )
    thread = threading.Thread(
        target=server.serve_forever,
        name="harry-botter-audio-stream",
        daemon=True,
    )
    thread.start()
    return server, thread
