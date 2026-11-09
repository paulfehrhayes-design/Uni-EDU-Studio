"""Speech-to-text via faster-whisper."""

import numpy as np
from faster_whisper import WhisperModel

# Phrases faster-whisper hallucinates on near-silent/empty audio.
_HALLUCINATION_DENYLIST = {
    "thank you.",
    "thank you",
    "thanks for watching.",
    "thanks for watching",
    "you",
    "bye.",
    "bye",
    "bye-bye.",
    "okay.",
    "ok.",
}


class Transcriber:
    """Wraps a faster-whisper model to turn raw audio into a transcript."""

    def __init__(self, model_size: str, device: str, compute_type: str) -> None:
        self._model = WhisperModel(model_size, device=device, compute_type=compute_type)

    def transcribe(self, audio: np.ndarray) -> str:
        """Transcribe mono float32 audio at 16kHz. Returns '' for silence/hallucinations."""
        segments, _ = self._model.transcribe(audio, beam_size=1, language="en")
        text = "".join(segment.text for segment in segments).strip()
        if len(text) < 2:
            return ""
        if text.lower().strip() in _HALLUCINATION_DENYLIST:
            return ""
        return text
