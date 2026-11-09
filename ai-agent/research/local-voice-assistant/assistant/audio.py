"""Microphone capture: push-to-talk recording, or automatic voice activity detection.

Uses pynput for global key detection: it works on Windows without admin
rights (unlike some alternatives) and provides clean press/release callbacks.
Push-to-talk key: Right Ctrl.
"""

import queue
import threading
from typing import Callable, Optional

import numpy as np
import sounddevice as sd
import torch
from pynput import keyboard
from silero_vad import load_silero_vad

SAMPLE_RATE = 16000
_VAD_FRAME_SAMPLES = 512  # Silero VAD's required chunk size at 16kHz (32ms, closest to 30ms)

DEFAULT_KEY = keyboard.Key.ctrl_r
DEFAULT_KEY_NAME = "Right Ctrl"


class PushToTalkRecorder:
    """Records microphone audio for as long as a chosen key is held down."""

    def __init__(
        self, key=DEFAULT_KEY, key_name: str = DEFAULT_KEY_NAME, sample_rate: int = SAMPLE_RATE
    ) -> None:
        self.key = key
        self.key_name = key_name
        self.sample_rate = sample_rate

    def record(self) -> np.ndarray:
        """Block until the key is pressed, capture audio until released, return mono float32 samples."""
        frames: list[np.ndarray] = []
        recording = threading.Event()
        released = threading.Event()

        def on_press(pressed_key):
            if pressed_key == self.key:
                recording.set()

        def on_release(pressed_key):
            if pressed_key == self.key:
                released.set()
                return False

        def audio_callback(indata, frame_count, time_info, status):
            if recording.is_set():
                frames.append(indata[:, 0].copy())

        listener = keyboard.Listener(on_press=on_press, on_release=on_release)
        listener.start()
        try:
            with sd.InputStream(
                samplerate=self.sample_rate, channels=1, dtype="float32", callback=audio_callback
            ):
                released.wait()
        finally:
            listener.stop()

        if not frames:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(frames)


class VADRecorder:
    """Runs Silero VAD continuously on the microphone for as long as the process needs it,
    delivering complete utterances through a queue.

    Runs on 32ms frames (Silero's required chunk size; closest to the 30ms
    asked for). Two capture modes, chosen per-frame by whether barge-in is
    currently armed:

    - Disarmed (normal turn-taking): buffering starts the instant speech
      probability crosses `threshold`, exactly as before.
    - Armed (assistant busy generating/speaking): a burst of speech must
      stay above `threshold` continuously for `bargein_ms` before anything
      happens, to avoid the assistant's own voice leaking into the mic and
      triggering itself. Once confirmed, `on_bargein` fires and capture
      begins immediately, seeded with the confirmation-window audio so the
      start of the interruption isn't lost.

    Either way, the utterance ends once probability stays below threshold for
    `silence_ms`, and utterances with less than `min_speech_ms` of actual
    speech content are dropped as noise (delivered as an empty array).
    """

    def __init__(
        self,
        sample_rate: int = SAMPLE_RATE,
        threshold: float = 0.5,
        silence_ms: int = 700,
        min_speech_ms: int = 300,
        bargein_ms: int = 250,
        on_speech_start: Optional[Callable[[], None]] = None,
    ) -> None:
        if sample_rate not in (8000, 16000):
            raise ValueError("Silero VAD only supports 8000 or 16000 Hz")
        self.sample_rate = sample_rate
        self.threshold = threshold
        self._frame_samples = _VAD_FRAME_SAMPLES if sample_rate == 16000 else 256
        frame_ms = self._frame_samples / sample_rate * 1000
        self._silence_frames_needed = max(1, round(silence_ms / frame_ms))
        self._min_speech_samples = round(min_speech_ms / 1000 * sample_rate)
        self._bargein_samples = round(bargein_ms / 1000 * sample_rate)
        self._on_speech_start = on_speech_start or (lambda: None)
        self._model = load_silero_vad()

        self._utterances: queue.Queue = queue.Queue()
        self._mode_lock = threading.Lock()
        self._mode = "listening"  # "listening" | "armed" | "muted"
        self._on_bargein: Optional[Callable[[], None]] = None
        self._stop_event = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        """Start listening in the background. Call once."""
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()

    def listen_for_next_turn(self) -> None:
        """Normal idle mode: any speech immediately starts capturing a new utterance."""
        with self._mode_lock:
            self._mode = "listening"
            self._on_bargein = None

    def arm_bargein(self, on_bargein: Callable[[], None]) -> None:
        """Busy mode with barge-in enabled: `bargein_ms` of sustained speech interrupts."""
        with self._mode_lock:
            self._mode = "armed"
            self._on_bargein = on_bargein

    def mute(self) -> None:
        """Busy mode with barge-in disabled: ignore the mic entirely until re-armed."""
        with self._mode_lock:
            self._mode = "muted"
            self._on_bargein = None

    def get_utterance(self) -> np.ndarray:
        """Block until the next complete utterance is ready (normal turn or barge-in)."""
        return self._utterances.get()

    def _run(self) -> None:
        self._model.reset_states()
        buffer: list[np.ndarray] = []
        pending: list[np.ndarray] = []  # barge-in confirmation window, while armed
        capturing = False
        silence_run = 0
        speech_samples = 0

        with sd.InputStream(
            samplerate=self.sample_rate,
            channels=1,
            dtype="float32",
            blocksize=self._frame_samples,
        ) as stream:
            while not self._stop_event.is_set():
                frame, _ = stream.read(self._frame_samples)
                frame = frame[:, 0].copy()
                prob = self._model(torch.from_numpy(frame), self.sample_rate).item()
                is_speech = prob >= self.threshold

                if not capturing:
                    with self._mode_lock:
                        mode = self._mode
                        on_bargein = self._on_bargein

                    if mode == "muted":
                        pending = []
                        continue

                    if mode == "listening":
                        pending = []
                        if is_speech:
                            capturing = True
                            buffer = [frame]
                            speech_samples = len(frame)
                            silence_run = 0
                            self._on_speech_start()
                        continue

                    # mode == "armed": require sustained speech before committing,
                    # so the assistant's own voice leaking into the mic can't
                    # trigger a false interruption from a brief blip.
                    if not is_speech:
                        pending = []
                        continue
                    pending.append(frame)
                    if sum(len(f) for f in pending) < self._bargein_samples:
                        continue
                    # Sustained speech confirmed: this is a real interruption, not echo.
                    if on_bargein:
                        try:
                            on_bargein()
                        except Exception:
                            pass
                    capturing = True
                    buffer = pending
                    speech_samples = sum(len(f) for f in pending)
                    pending = []
                    silence_run = 0
                    continue

                buffer.append(frame)
                if is_speech:
                    speech_samples += len(frame)
                    silence_run = 0
                else:
                    silence_run += 1
                    if silence_run >= self._silence_frames_needed:
                        utterance = (
                            np.concatenate(buffer)
                            if speech_samples >= self._min_speech_samples
                            else np.zeros(0, dtype=np.float32)
                        )
                        self._utterances.put(utterance)
                        buffer = []
                        capturing = False
                        speech_samples = 0
                        silence_run = 0
