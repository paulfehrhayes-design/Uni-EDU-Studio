"""Optional, local-only speech recognition and synthesis adapters."""

import importlib.util
import io
import os
import tempfile
import threading
import wave
from pathlib import Path

MAX_AUDIO_BYTES = 8_000_000
MAX_SPEECH_CHARS = 2_000
MIN_TTS_SPEED = 0.75
MAX_TTS_SPEED = 1.25
ALLOWED_AUDIO_TYPES = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".mp4",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
}
SPEECH_SAMPLE_RATE = 24_000
STREAM_SAMPLE_RATE = 16_000
MAX_STREAM_UTTERANCE_BYTES = 640_000


class SpeechRuntimeError(RuntimeError):
    """Raised when an installed local speech runtime fails."""


class SpeechRuntimeNotConfigured(SpeechRuntimeError):
    """Raised when an optional speech dependency is not installed."""


def create_kokoro_pipeline(device: str = "cpu"):
    try:
        import espeakng_loader
        from kokoro import KPipeline
        from phonemizer.backend.espeak.wrapper import EspeakWrapper
    except ImportError as exc:
        raise SpeechRuntimeNotConfigured(
            "Kokoro and its eSpeak pronunciation support are not installed. Reinstall the audio extra."
        ) from exc
    try:
        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
        return KPipeline(lang_code="a", device=device)
    except (OSError, RuntimeError, ValueError) as exc:
        raise SpeechRuntimeError(
            "Could not load the local Kokoro voice model. Check its cache."
        ) from exc


class LocalSpeechRuntime:
    def __init__(self) -> None:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        self.transcription_model = os.environ.get(
            "HARRY_BOTTER_WHISPER_MODEL",
            "Systran/faster-whisper-tiny.en",
        )
        self.transcription_device = os.environ.get("HARRY_BOTTER_STT_DEVICE", "cpu")
        self.transcription_compute_type = os.environ.get(
            "HARRY_BOTTER_STT_COMPUTE_TYPE",
            "int8",
        )
        self.transcription_cpu_threads = int(
            os.environ.get("HARRY_BOTTER_STT_CPU_THREADS", "2")
        )
        self.tts_voice = os.environ.get("HARRY_BOTTER_TTS_VOICE", "af_heart")
        self._transcriber = None
        self._synthesizer = None
        self._model_lock = threading.Lock()

    def status(self) -> dict[str, object]:
        streaming_ready = all(
            importlib.util.find_spec(package) is not None
            for package in ("faster_whisper", "numpy", "webrtcvad", "websockets")
        )
        return {
            "transcription": {
                "available": importlib.util.find_spec("faster_whisper") is not None,
                "model": self.transcription_model,
                "device": self.transcription_device,
                "cpu_threads": self.transcription_cpu_threads,
            },
            "speech_generation": {
                "available": importlib.util.find_spec("kokoro") is not None,
                "voice": self.tts_voice,
            },
            "streaming_transcription": {
                "available": streaming_ready,
                "sample_rate": STREAM_SAMPLE_RATE,
                "diarization_available": False,
            },
        }

    def transcribe(self, audio: bytes, content_type: str) -> str:
        suffix = ALLOWED_AUDIO_TYPES.get(content_type)
        if suffix is None:
            raise ValueError("Use a supported browser audio recording format.")
        if not audio or len(audio) > MAX_AUDIO_BYTES:
            raise ValueError("Audio must be non-empty and no larger than 8 MB.")
        with self._model_lock:
            transcriber = self._get_transcriber()
            try:
                with tempfile.TemporaryDirectory(prefix="harry-botter-audio-") as directory:
                    audio_path = Path(directory) / f"recording{suffix}"
                    audio_path.write_bytes(audio)
                    segments, _ = transcriber.transcribe(
                        str(audio_path),
                        beam_size=1,
                        language="en",
                        vad_filter=True,
                    )
                    return " ".join(segment.text.strip() for segment in segments).strip()
            except (OSError, RuntimeError, ValueError) as exc:
                raise SpeechRuntimeError("Could not transcribe this local audio recording.") from exc

    def transcribe_pcm(self, audio: bytes) -> str:
        if not audio or len(audio) > MAX_STREAM_UTTERANCE_BYTES or len(audio) % 2:
            raise ValueError("Streaming audio must be non-empty 16-bit PCM no longer than 20 seconds.")
        try:
            import numpy as np
        except ImportError as exc:
            raise SpeechRuntimeNotConfigured(
                "NumPy is required for local streaming transcription."
            ) from exc

        samples = np.frombuffer(audio, dtype="<i2").astype(np.float32) / 32768.0
        with self._model_lock:
            transcriber = self._get_transcriber()
            try:
                segments, _ = transcriber.transcribe(
                    samples,
                    beam_size=1,
                    language="en",
                    vad_filter=False,
                )
                return " ".join(segment.text.strip() for segment in segments).strip()
            except (OSError, RuntimeError, ValueError) as exc:
                raise SpeechRuntimeError("Could not transcribe this local speech segment.") from exc

    def _get_transcriber(self):
        if self._transcriber is not None:
            return self._transcriber
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise SpeechRuntimeNotConfigured(
                "Speech recognition is not installed. Follow the local audio setup instructions."
            ) from exc
        try:
            self._transcriber = WhisperModel(
                self.transcription_model,
                device=self.transcription_device,
                compute_type=self.transcription_compute_type,
                cpu_threads=self.transcription_cpu_threads,
            )
        except (OSError, RuntimeError, ValueError) as exc:
            raise SpeechRuntimeError(
                "Could not load the local Whisper model. Check its cache and CPU settings."
            ) from exc
        return self._transcriber

    def synthesize(self, text: str, speed: float = 1.0) -> bytes:
        spoken_text = text.strip()
        if not spoken_text or len(spoken_text) > MAX_SPEECH_CHARS:
            raise ValueError(f"Speech text must contain 1 to {MAX_SPEECH_CHARS} characters.")
        if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not MIN_TTS_SPEED <= speed <= MAX_TTS_SPEED:
            raise ValueError(f"Speech speed must be between {MIN_TTS_SPEED} and {MAX_TTS_SPEED}.")
        try:
            import numpy as np
        except ImportError as exc:
            raise SpeechRuntimeNotConfigured(
                "Speech generation is not installed. Follow the local audio setup instructions."
            ) from exc

        with self._model_lock:
            if self._synthesizer is None:
                self._synthesizer = create_kokoro_pipeline(
                    device=os.environ.get("HARRY_BOTTER_TTS_DEVICE", "cpu"),
                )
            try:
                chunks = [
                    result.audio.detach().cpu().numpy()
                    for result in self._synthesizer(spoken_text, voice=self.tts_voice, speed=float(speed))
                    if result.audio is not None
                ]
            except (OSError, RuntimeError, ValueError) as exc:
                raise SpeechRuntimeError("Could not synthesize this local speech.") from exc

        if not chunks:
            raise SpeechRuntimeError("The local speech model returned no audio.")
        samples = np.concatenate(chunks).astype(np.float32)
        pcm_samples = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(SPEECH_SAMPLE_RATE)
            wav_file.writeframes(pcm_samples.tobytes())
        return output.getvalue()
