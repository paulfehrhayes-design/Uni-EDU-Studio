import json
import struct
import threading
import unittest
from types import SimpleNamespace

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

from harry_botter_voice.streaming import (
    STREAM_FRAME_BYTES,
    STREAM_FRAME_SAMPLES,
    STREAM_SAMPLE_RATE,
    STREAM_SUBPROTOCOL,
    StreamingSpeechSession,
    start_audio_stream_server,
)
from harry_botter_voice.speech import LocalSpeechRuntime, SpeechRuntimeNotConfigured


class FakeSpeechRuntime:
    def __init__(self) -> None:
        self.audio = None

    def transcribe_pcm(self, audio: bytes) -> str:
        self.audio = audio
        return "A local streaming transcript."


class FakeVAD:
    def is_speech(self, frame: bytes, sample_rate: int) -> bool:
        return frame == b"\x01" * STREAM_FRAME_BYTES and sample_rate == STREAM_SAMPLE_RATE


class FakeWhisper:
    def transcribe(self, samples, **options):
        self.samples = samples
        self.options = options
        return [SimpleNamespace(text=" local "), SimpleNamespace(text=" transcript ")], None


class StreamingSpeechSessionTests(unittest.TestCase):
    def test_pcm_transcription_uses_local_whisper_with_normalized_samples(self) -> None:
        runtime = LocalSpeechRuntime()
        whisper = FakeWhisper()
        runtime._transcriber = whisper
        audio = struct.pack("<h", 16_384) * STREAM_FRAME_SAMPLES

        transcript = runtime.transcribe_pcm(audio)

        self.assertEqual(transcript, "local transcript")
        self.assertEqual(len(whisper.samples), STREAM_FRAME_SAMPLES)
        self.assertAlmostEqual(float(whisper.samples[0]), 0.5)
        self.assertEqual(whisper.options["language"], "en")
        self.assertFalse(whisper.options["vad_filter"])

    def test_vad_segments_speech_in_order_and_discards_audio_after_transcription(self) -> None:
        runtime = FakeSpeechRuntime()
        session = StreamingSpeechSession(runtime, FakeVAD())
        session.start("teacher-preview-session")
        speech_frame = b"\x01" * STREAM_FRAME_BYTES
        silence_frame = bytes(STREAM_FRAME_BYTES)

        self.assertEqual(session.feed(speech_frame), [])
        self.assertEqual(session.feed(speech_frame), [])
        started = session.feed(speech_frame)
        self.assertEqual(started[0]["type"], "speech_started")

        events = []
        for _ in range(15):
            events.extend(session.feed(silence_frame))

        self.assertEqual([event["type"] for event in events], ["transcript_final", "speech_ended"])
        transcript = events[0]
        self.assertEqual(transcript["text"], "A local streaming transcript.")
        self.assertIsNone(transcript["speaker"])
        self.assertFalse(transcript["diarization_available"])
        self.assertEqual(
            [started[0]["sequence"], *(event["sequence"] for event in events)],
            sorted([started[0]["sequence"], *(event["sequence"] for event in events)]),
        )
        self.assertGreater(len(runtime.audio), 0)
        self.assertEqual(session._utterance_frames, [])

    def test_missing_local_whisper_returns_an_explicit_event_and_clears_audio(self) -> None:
        class MissingWhisperRuntime(LocalSpeechRuntime):
            def _get_transcriber(self):
                raise SpeechRuntimeNotConfigured(
                    "Speech recognition is not installed. Follow the local audio setup instructions."
                )

        session = StreamingSpeechSession(MissingWhisperRuntime(), FakeVAD())
        session.start("missing-model-session")
        speech_frame = b"\x01" * STREAM_FRAME_BYTES
        silence_frame = bytes(STREAM_FRAME_BYTES)
        for _ in range(3):
            session.feed(speech_frame)

        events = []
        for _ in range(15):
            events.extend(session.feed(silence_frame))

        self.assertEqual(events[0]["type"], "error")
        self.assertEqual(events[0]["code"], "transcription_error")
        self.assertIn("Speech recognition is not installed", events[0]["message"])
        self.assertEqual(events[1]["type"], "speech_ended")
        self.assertEqual(session._utterance_frames, [])

    def test_invalid_frame_size_is_rejected(self) -> None:
        session = StreamingSpeechSession(FakeSpeechRuntime(), FakeVAD())
        session.start("session")

        with self.assertRaisesRegex(ValueError, "20 ms"):
            session.feed(bytes(STREAM_FRAME_BYTES - 1))

    def test_stream_server_accepts_local_audio_and_stops_cleanly(self) -> None:
        runtime = FakeSpeechRuntime()
        server, thread = start_audio_stream_server(runtime, port=0, vad_factory=FakeVAD)
        port = server.socket.getsockname()[1]
        try:
            with connect(
                f"ws://127.0.0.1:{port}/api/v1/audio-stream",
                subprotocols=[STREAM_SUBPROTOCOL],
                proxy=None,
                open_timeout=2,
            ) as client:
                client.send(json.dumps({
                    "type": "start",
                    "session_id": "stream-test",
                    "sample_rate": STREAM_SAMPLE_RATE,
                    "format": "pcm_s16le_mono",
                }))
                self.assertEqual(json.loads(client.recv(timeout=2))["type"], "ready")
                client.send(json.dumps({"type": "stop"}))
                stopped = json.loads(client.recv(timeout=2))
                self.assertEqual(stopped["type"], "stopped")
                self.assertEqual(stopped["session_id"], "stream-test")
        finally:
            server.shutdown()
            thread.join(timeout=3)
        self.assertFalse(thread.is_alive())

    def test_stream_start_rejects_unsupported_audio_format(self) -> None:
        server, thread = start_audio_stream_server(
            FakeSpeechRuntime(),
            port=0,
            vad_factory=FakeVAD,
        )
        port = server.socket.getsockname()[1]
        try:
            with connect(
                f"ws://127.0.0.1:{port}/api/v1/audio-stream",
                subprotocols=[STREAM_SUBPROTOCOL],
                proxy=None,
                open_timeout=2,
            ) as client:
                client.send(json.dumps({
                    "type": "start",
                    "session_id": "stream-test",
                    "sample_rate": 44100,
                    "format": "audio/webm",
                }))
                error = json.loads(client.recv(timeout=2))
                self.assertEqual(error["type"], "error")
                self.assertEqual(error["code"], "invalid_stream_start")
                with self.assertRaises(ConnectionClosed):
                    client.recv(timeout=2)
        finally:
            server.shutdown()
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
