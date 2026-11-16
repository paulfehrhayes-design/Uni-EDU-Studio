import io
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import Mock

try:
    import numpy as np
except ImportError:
    np = None

from harry_botter_voice.speech import LocalSpeechRuntime


@unittest.skipIf(np is None, "NumPy is required for the optional speech extra.")
class LocalSpeechRuntimeTests(unittest.TestCase):
    def test_synthesize_forwards_selected_speed_to_kokoro(self) -> None:
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


if __name__ == "__main__":
    unittest.main()
