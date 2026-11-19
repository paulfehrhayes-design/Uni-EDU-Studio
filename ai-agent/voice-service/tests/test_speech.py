import io
import os
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import Mock, PropertyMock, patch

try:
    import numpy as np
except ImportError:
    np = None

from harry_botter_voice.speech import (
    LocalSpeechRuntime,
    QWEN_VOICE_DESIGN_ID,
    kokoro_language_code,
)


class KokoroLanguageTests(unittest.TestCase):
    def test_british_presets_use_the_british_pipeline(self) -> None:
        self.assertEqual(kokoro_language_code("bm_fable"), "b")
        self.assertEqual(kokoro_language_code("bm_george"), "b")
        self.assertEqual(kokoro_language_code("af_heart"), "a")

    def test_qwen_voice_design_is_listed_only_when_opted_in_and_supported(self) -> None:
        runtime = LocalSpeechRuntime()
        with (
            patch.dict(os.environ, {"HARRY_BOTTER_ENABLE_QWEN_VOICE_DESIGN": "1"}),
            patch("harry_botter_voice.speech.importlib.util.find_spec", return_value=object()),
            patch("harry_botter_voice.speech.qwen_voice_design_device", return_value="cuda:0"),
        ):
            self.assertIn(QWEN_VOICE_DESIGN_ID, runtime.available_voices())
        with patch.dict(os.environ, {"HARRY_BOTTER_ENABLE_QWEN_VOICE_DESIGN": "0"}):
            self.assertNotIn(QWEN_VOICE_DESIGN_ID, runtime.available_voices())

    def test_speech_status_reports_missing_stream_and_kokoro_dependencies(self) -> None:
        runtime = LocalSpeechRuntime()
        with (
            patch("harry_botter_voice.speech.importlib.util.find_spec", return_value=None),
            patch("harry_botter_voice.speech.qwen_voice_design_device", return_value=None),
            patch.dict(os.environ, {"HARRY_BOTTER_ENABLE_QWEN_VOICE_DESIGN": "0"}),
        ):
            status = runtime.status()

        self.assertEqual(
            status["streaming_transcription"]["missing_dependencies"],
            ["faster_whisper", "numpy", "webrtcvad", "websockets"],
        )
        self.assertEqual(
            status["speech_generation"]["missing_dependencies"],
            ["kokoro", "numpy", "torch", "espeakng_loader", "phonemizer"],
        )
        self.assertEqual(status["speech_generation"]["available_voices"], [])

    def test_selected_qwen_voice_routes_to_its_local_generator(self) -> None:
        runtime = LocalSpeechRuntime()
        with (
            patch.object(
                LocalSpeechRuntime,
                "qwen_voice_design_available",
                new_callable=PropertyMock,
                return_value=True,
            ),
            patch.object(runtime, "_synthesize_qwen_voice_design", return_value=b"RIFF-test") as synthesize,
        ):
            result = runtime.synthesize("A sample.", speed=1.15, voice=QWEN_VOICE_DESIGN_ID)

        self.assertEqual(result, b"RIFF-test")
        synthesize.assert_called_once_with("A sample.", 1.15)


@unittest.skipIf(np is None, "NumPy is required for the optional speech extra.")
class LocalSpeechRuntimeTests(unittest.TestCase):
    def test_warmup_synthesizes_and_discards_a_short_default_voice_sample(self) -> None:
        runtime = LocalSpeechRuntime()
        with patch.object(runtime, "synthesize", return_value=b"RIFF-test") as synthesize:
            result = runtime.warmup()

        self.assertEqual(result, {"status": "ready", "voice": "af_heart"})
        synthesize.assert_called_once_with("Voice ready.", speed=1.0, voice="af_heart")

    def test_synthesize_uses_configured_voice_and_speed_with_kokoro(self) -> None:
        class FakeTensor:
            def detach(self):
                return self

            def cpu(self):
                return self

            def numpy(self):
                return np.array([-0.5, 0.0, 0.5])

        synthesizer = Mock(
            return_value=[SimpleNamespace(audio=FakeTensor())],
        )
        runtime = LocalSpeechRuntime()
        runtime._synthesizer = synthesizer

        runtime.tts_voice = "af_heart"
        audio = runtime.synthesize("A clear answer.", speed=1.15)

        synthesizer.assert_called_once_with(
            "A clear answer.",
            voice="af_heart",
            speed=1.15,
        )
        with wave.open(io.BytesIO(audio), "rb") as wav:
            self.assertEqual(wav.getframerate(), 24_000)
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getsampwidth(), 2)
            self.assertEqual(wav.getnframes(), 3)

    def test_qwen_voice_design_uses_description_and_encodes_returned_sample_rate(self) -> None:
        model = Mock()
        model.generate_voice_design.return_value = ([np.array([-0.5, 0.0, 0.5])], 22_050)
        runtime = LocalSpeechRuntime()
        runtime._qwen_voice_design_model = model

        with patch.object(
            LocalSpeechRuntime,
            "qwen_voice_design_available",
            new_callable=PropertyMock,
            return_value=True,
        ):
            audio = runtime.synthesize(
                "A fictional voice sample.",
                speed=1.15,
                voice=QWEN_VOICE_DESIGN_ID,
            )

        model.generate_voice_design.assert_called_once()
        generation = model.generate_voice_design.call_args.kwargs
        self.assertEqual(generation["text"], "A fictional voice sample.")
        self.assertEqual(generation["language"], "English")
        self.assertIn("Fulham area", generation["instruct"])
        self.assertIn("brisk", generation["instruct"])
        with wave.open(io.BytesIO(audio), "rb") as wav:
            self.assertEqual(wav.getframerate(), 22_050)
            self.assertEqual(wav.getnframes(), 3)


if __name__ == "__main__":
    unittest.main()
