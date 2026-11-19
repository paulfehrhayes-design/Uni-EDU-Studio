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
QWEN_VOICE_DESIGN_ID = "qwen3_youthful_south_london"
QWEN_VOICE_DESIGN_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
QWEN_VOICE_DESIGN_INSTRUCTION = (
    "A fictional boy's voice around age 12, speaking English with a natural "
    "South London accent associated with the Fulham area. Use clear articulation, "
    "a warm tone, and lively energy. Do not imitate any real person or use a "
    "real child's recorded voice."
)
SUPPORTED_TTS_VOICES = (
    "af_heart",
    "af_bella",
    "af_nicole",
    "am_michael",
    "bm_fable",
    "bm_george",
)
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


def kokoro_language_code(voice: str) -> str:
    return "b" if voice.startswith(("bf_", "bm_")) else "a"


def create_kokoro_pipeline(device: str = "cpu", lang_code: str = "a"):
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
        return KPipeline(lang_code=lang_code, device=device)
    except (OSError, RuntimeError, ValueError) as exc:
        raise SpeechRuntimeError(
            "Could not load the local Kokoro voice model. Check its cache."
        ) from exc


def qwen_voice_design_device() -> str | None:
    configured_device = os.environ.get("HARRY_BOTTER_QWEN_TTS_DEVICE")
    if configured_device:
        return configured_device
    if importlib.util.find_spec("torch") is None:
        return None
    try:
        import torch
    except ImportError:
        return None
    if torch.cuda.is_available():
        return "cuda:0"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return None


def create_qwen_voice_design_model():
    try:
        import torch
        from qwen_tts import Qwen3TTSModel
    except ImportError as exc:
        raise SpeechRuntimeNotConfigured(
            'Qwen3 VoiceDesign is optional. Install it with: pip install -e ".[audio,voice-design]"'
        ) from exc
    device = qwen_voice_design_device()
    if device is None:
        raise SpeechRuntimeNotConfigured(
            "Qwen3 VoiceDesign needs a CUDA or Apple Silicon GPU by default. "
            "Set HARRY_BOTTER_QWEN_TTS_DEVICE only if you intend to run on another device."
        )
    dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
    try:
        return Qwen3TTSModel.from_pretrained(
            QWEN_VOICE_DESIGN_MODEL,
            device_map=device,
            dtype=dtype,
            low_cpu_mem_usage=True,
        )
    except (OSError, RuntimeError, ValueError) as exc:
        raise SpeechRuntimeError(
            "Could not load the local Qwen3 VoiceDesign model. Run the voice-design setup command and check model terms."
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
        self._synthesizer_language_code = None
        self._qwen_voice_design_model = None
        self._model_lock = threading.Lock()

    @property
    def qwen_voice_design_available(self) -> bool:
        return (
            os.environ.get("HARRY_BOTTER_ENABLE_QWEN_VOICE_DESIGN") == "1"
            and importlib.util.find_spec("qwen_tts") is not None
            and qwen_voice_design_device() is not None
        )

    @property
    def kokoro_available(self) -> bool:
        return all(
            importlib.util.find_spec(package) is not None
            for package in ("kokoro", "numpy", "espeakng_loader", "phonemizer")
        )

    def available_voices(self) -> list[str]:
        voices = list(SUPPORTED_TTS_VOICES) if self.kokoro_available else []
        if self.qwen_voice_design_available:
            voices.append(QWEN_VOICE_DESIGN_ID)
        return voices

    def status(self) -> dict[str, object]:
        transcription_packages = ("faster_whisper", "numpy")
        streaming_packages = (*transcription_packages, "webrtcvad", "websockets")
        missing_streaming_packages = [
            package
            for package in streaming_packages
            if importlib.util.find_spec(package) is None
        ]
        kokoro_packages = ("kokoro", "numpy", "torch", "espeakng_loader", "phonemizer")
        missing_kokoro_packages = [
            package
            for package in kokoro_packages
            if importlib.util.find_spec(package) is None
        ]
        return {
            "transcription": {
                "available": not any(
                    importlib.util.find_spec(package) is None
                    for package in transcription_packages
                ),
                "model": self.transcription_model,
                "device": self.transcription_device,
                "cpu_threads": self.transcription_cpu_threads,
                "missing_dependencies": [
                    package
                    for package in ("faster_whisper", "numpy")
                    if importlib.util.find_spec(package) is None
                ],
            },
            "speech_generation": {
                "available": (
                    self.kokoro_available
                    or self.qwen_voice_design_available
                ),
                "kokoro_available": self.kokoro_available,
                "missing_dependencies": missing_kokoro_packages,
                "voice": self.tts_voice,
                "available_voices": self.available_voices(),
                "voice_design": {
                    "enabled": os.environ.get("HARRY_BOTTER_ENABLE_QWEN_VOICE_DESIGN") == "1",
                    "available": self.qwen_voice_design_available,
                    "device": qwen_voice_design_device() if self.qwen_voice_design_available else None,
                    "model": QWEN_VOICE_DESIGN_MODEL,
                },
            },
            "streaming_transcription": {
                "available": not missing_streaming_packages,
                "missing_dependencies": missing_streaming_packages,
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

    def synthesize(
        self,
        text: str,
        speed: float = 1.0,
        voice: str | None = None,
    ) -> bytes:
        spoken_text = text.strip()
        if not spoken_text or len(spoken_text) > MAX_SPEECH_CHARS:
            raise ValueError(f"Speech text must contain 1 to {MAX_SPEECH_CHARS} characters.")
        if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not MIN_TTS_SPEED <= speed <= MAX_TTS_SPEED:
            raise ValueError(f"Speech speed must be between {MIN_TTS_SPEED} and {MAX_TTS_SPEED}.")
        selected_voice = self.tts_voice if voice is None else voice
        if selected_voice == QWEN_VOICE_DESIGN_ID:
            if not self.qwen_voice_design_available:
                raise SpeechRuntimeNotConfigured(
                    "Enable Qwen3 VoiceDesign and complete its model setup before selecting this voice."
                )
            return self._synthesize_qwen_voice_design(spoken_text, float(speed))
        if selected_voice not in SUPPORTED_TTS_VOICES:
            raise SpeechRuntimeError(
                "Choose a supported generic Kokoro voice or update "
                "HARRY_BOTTER_TTS_VOICE."
            )
        try:
            import numpy as np
        except ImportError as exc:
            raise SpeechRuntimeNotConfigured(
                "Speech generation is not installed. Follow the local audio setup instructions."
            ) from exc

        with self._model_lock:
            language_code = kokoro_language_code(selected_voice)
            if self._synthesizer is None or self._synthesizer_language_code != language_code:
                self._synthesizer = create_kokoro_pipeline(
                    device=os.environ.get("HARRY_BOTTER_TTS_DEVICE", "cpu"),
                    lang_code=language_code,
                )
                self._synthesizer_language_code = language_code
            try:
                chunks = [
                    result.audio.detach().cpu().numpy()
                    for result in self._synthesizer(spoken_text, voice=selected_voice, speed=float(speed))
                    if result.audio is not None
                ]
            except (OSError, RuntimeError, ValueError) as exc:
                raise SpeechRuntimeError("Could not synthesize this local speech.") from exc

        if not chunks:
            raise SpeechRuntimeError("The local speech model returned no audio.")
        return self._encode_wav(np.concatenate(chunks), SPEECH_SAMPLE_RATE, np)

    def _synthesize_qwen_voice_design(self, text: str, speed: float) -> bytes:
        try:
            import numpy as np
        except ImportError as exc:
            raise SpeechRuntimeNotConfigured(
                "NumPy is required for Qwen3 VoiceDesign audio conversion."
            ) from exc
        with self._model_lock:
            if self._qwen_voice_design_model is None:
                self._qwen_voice_design_model = create_qwen_voice_design_model()
            pace = (
                "Use a measured, slightly slower speaking pace."
                if speed < 0.95
                else "Use a brisk but clearly articulated speaking pace."
                if speed > 1.05
                else "Use a natural conversational speaking pace."
            )
            try:
                wavs, sample_rate = self._qwen_voice_design_model.generate_voice_design(
                    text=text,
                    language="English",
                    instruct=f"{QWEN_VOICE_DESIGN_INSTRUCTION} {pace}",
                    do_sample=False,
                )
            except (OSError, RuntimeError, ValueError) as exc:
                raise SpeechRuntimeError("Could not synthesize the Qwen3 designed voice.") from exc
        if not wavs:
            raise SpeechRuntimeError("Qwen3 VoiceDesign returned no audio.")
        samples = wavs[0]
        if hasattr(samples, "detach"):
            samples = samples.detach().cpu().numpy()
        return self._encode_wav(samples, int(sample_rate), np)

    @staticmethod
    def _encode_wav(samples, sample_rate: int, np) -> bytes:
        samples = np.asarray(samples, dtype=np.float32).reshape(-1)
        pcm_samples = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(pcm_samples.tobytes())
        return output.getvalue()
