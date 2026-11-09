"""Text-to-speech via Kokoro, plus a queued audio player for streaming playback."""

import queue
import re
import sys
import threading

import numpy as np
import sounddevice as sd
from kokoro import KPipeline

SAMPLE_RATE = 24000  # Kokoro's fixed output sample rate

_CODE_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`([^`]*)`")
_URL_RE = re.compile(r"https?://\S+|www\.\S+")
_MARKDOWN_CHARS_RE = re.compile(r"[*_~#>`]+")
_BULLET_RE = re.compile(r"^\s*[-*•]\s+", re.MULTILINE)
_WHITESPACE_RE = re.compile(r"[ \t]+")

# Symbols the LLM sometimes reaches for that misaki's G2P either mispronounces
# or outright crashes on (it can return None for a token's phonemes on an
# unmapped character, which upstream code then fails to concatenate). Spell
# them out instead of dropping them silently.
_SYMBOL_WORDS = {
    "×": " times ",
    "÷": " divided by ",
    "±": " plus or minus ",
    "≈": " approximately ",
    "≠": " not equal to ",
    "≤": " less than or equal to ",
    "≥": " greater than or equal to ",
    "°": " degrees ",
    "%": " percent ",
    "&": " and ",
    "@": " at ",
    "=": " equals ",
    "+": " plus ",
    "$": " dollars ",
    "€": " euros ",
    "£": " pounds ",
    "™": "",
    "®": "",
    "©": "",
}
_SYMBOL_RE = re.compile("|".join(re.escape(k) for k in _SYMBOL_WORDS))

# Currency symbols are written before the amount but spoken after it ("$25" ->
# "twenty-five dollars"); handle that reordering before the generic map above
# turns it into "dollars 25".
_CURRENCY_WORDS = {"$": "dollars", "€": "euros", "£": "pounds"}
_CURRENCY_RE = re.compile(r"([$€£])\s*(\d+(?:\.\d+)?)")

# "Smart" punctuation LLMs commonly emit -- normalize to plain ASCII instead
# of letting the unspeakable-character filter below just delete it (which
# would turn e.g. a curly apostrophe in "They're" into "Theyre").
_PUNCT_NORMALIZE = {
    "‘": "'",
    "’": "'",
    "“": '"',
    "”": '"',
    "–": "-",
    "—": "-",
    "…": "...",
}
_PUNCT_NORMALIZE_RE = re.compile("|".join(re.escape(k) for k in _PUNCT_NORMALIZE))

# Whatever's left outside plain ASCII letters/digits and basic sentence
# punctuation can't be reliably phonemized (emoji, superscripts, exotic
# symbols) -- strip it rather than risk another crash on an unmapped one.
_UNSPEAKABLE_RE = re.compile(r"[^A-Za-z0-9\s.,!?'\":;()-]")


def sanitize_for_speech(text: str) -> str:
    """Strip markdown, code fences, bullets, URLs, and characters TTS can't speak."""
    text = _CODE_FENCE_RE.sub("", text)
    text = _INLINE_CODE_RE.sub(r"\1", text)
    text = _URL_RE.sub("", text)
    text = _BULLET_RE.sub("", text)
    text = _MARKDOWN_CHARS_RE.sub("", text)
    text = _PUNCT_NORMALIZE_RE.sub(lambda m: _PUNCT_NORMALIZE[m.group(0)], text)
    text = _CURRENCY_RE.sub(lambda m: f"{m.group(2)} {_CURRENCY_WORDS[m.group(1)]}", text)
    text = _SYMBOL_RE.sub(lambda m: _SYMBOL_WORDS[m.group(0)], text)
    text = _UNSPEAKABLE_RE.sub("", text)
    return _WHITESPACE_RE.sub(" ", text).strip()


def _silent_oov_fallback(token) -> tuple[str, int]:
    """Last-resort fallback, reached only if eSpeak NG failed to load. Without
    any fallback, misaki leaves an out-of-dictionary word's phonemes as None
    and crashes trying to join the sentence -- taking the whole chunk down
    with it. Returning empty phonemes instead means that one word goes silent
    (dropped from the audio) but the rest of the sentence still speaks."""
    return "", 1


def _load_espeak_library() -> None:
    """Point phonemizer at the eSpeak NG engine bundled in the espeakng_loader
    wheel, so misaki can phonemize words its dictionary doesn't have (names,
    brands) instead of dropping them.

    Must run before KPipeline is constructed: Kokoro builds its EspeakFallback
    during __init__ and quietly settles for no fallback if the native library
    isn't loadable. Without this, misaki only looks for a system-wide install
    (`C:\\Program Files\\eSpeak NG` on Windows), which isn't set up here.
    """
    try:
        import espeakng_loader
        from phonemizer.backend.espeak.wrapper import EspeakWrapper

        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
    except Exception as exc:
        print(
            f"\n[tts warning] eSpeak NG unavailable ({exc}); unknown words will be silent.",
            file=sys.stderr,
        )


# Words misaki's dictionary doesn't have and eSpeak's letter-to-sound rules
# then guess wrong ("Vivek" as "vye-vek", "Qwen" as "kyoo-wen"). Keys are
# lowercase, which matches any capitalization. Values must use only misaki's
# US phoneme vocab (misaki.en.US_VOCAB) -- a character outside it crashes the
# sentence. Words eSpeak already gets right (Ollama, Claude) don't belong here.
_PRONUNCIATION_OVERRIDES = {
    "vivek": "vɪvˈAk",
    "kokoro": "kOkˈOɹO",
    "qwen": "ʧwˈɛn",
}


class Synthesizer:
    """Wraps a Kokoro pipeline to turn text into audio samples."""

    def __init__(self, voice: str, lang_code: str = "a") -> None:
        self.voice = voice
        _load_espeak_library()
        self._pipeline = KPipeline(lang_code=lang_code)
        if getattr(self._pipeline.g2p, "fallback", None) is None:
            self._pipeline.g2p.fallback = _silent_oov_fallback
        self._pipeline.g2p.lexicon.golds.update(_PRONUNCIATION_OVERRIDES)

    def synthesize(self, text: str) -> np.ndarray:
        """Synthesize text to mono float32 audio samples at SAMPLE_RATE."""
        try:
            chunks = [
                result.audio.numpy()
                for result in self._pipeline(text, voice=self.voice)
                if result.audio is not None
            ]
        except Exception as exc:
            # Last-resort safety net for anything the fallback above doesn't
            # cover. Drop the chunk rather than take down the whole conversation.
            print(f"\n[tts warning] skipped a chunk it couldn't speak: {exc}", file=sys.stderr)
            return np.zeros(0, dtype=np.float32)
        if not chunks:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(chunks).astype(np.float32)


class Player:
    """Plays queued audio chunks in order through one persistent output stream.

    A realtime callback pulls samples from whichever chunk is current; flush()
    just drops the queue and the current chunk under a lock, no stream
    start/stop involved. That sidesteps two real problems found in earlier
    designs: the module-level `sd.play`/`sd.stop` API shares a global "last
    stream" reference that races with a producer/consumer queue (flush()
    could call `sd.stop()` before the playback thread's `sd.play()` had
    registered itself, silently doing nothing), and repeatedly opening/closing
    a fresh `sd.OutputStream` per chunk proved unstable (crashed outright
    under this backend when aborted mid-write from another thread).
    """

    def __init__(self, sample_rate: int = SAMPLE_RATE) -> None:
        self._sample_rate = sample_rate
        self._queue: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._current: np.ndarray | None = None
        self._current_on_complete = None
        self._pos = 0
        self._playing = threading.Event()
        self._stream = sd.OutputStream(
            samplerate=sample_rate, channels=1, dtype="float32", callback=self._callback
        )
        self._stream.start()

    def play(self, audio: np.ndarray, on_start=None, on_complete=None) -> None:
        """Queue audio for playback. `on_start` fires as playback begins; `on_complete`
        fires only if this chunk finishes naturally (never fires if flush() cuts it off)."""
        self._queue.put((audio, on_start, on_complete))

    def flush(self) -> None:
        """Drop everything queued and stop the current chunk immediately."""
        with self._lock:
            self._current = None
            self._current_on_complete = None
            self._pos = 0
            while not self._queue.empty():
                try:
                    self._queue.get_nowait()
                except queue.Empty:
                    break
        self._playing.clear()

    def is_playing(self) -> bool:
        return self._playing.is_set()

    def _callback(self, outdata: np.ndarray, frames: int, time_info, status) -> None:
        with self._lock:
            filled = 0
            while filled < frames:
                if self._current is None:
                    try:
                        self._current, on_start, on_complete = self._queue.get_nowait()
                    except queue.Empty:
                        break
                    self._pos = 0
                    self._current_on_complete = on_complete
                    self._playing.set()
                    if on_start:
                        try:
                            on_start()
                        except Exception:
                            pass

                take = min(frames - filled, len(self._current) - self._pos)
                outdata[filled : filled + take, 0] = self._current[self._pos : self._pos + take]
                self._pos += take
                filled += take

                if self._pos >= len(self._current):
                    on_complete = self._current_on_complete
                    self._current = None
                    self._current_on_complete = None
                    if on_complete:
                        try:
                            on_complete()
                        except Exception:
                            pass
            if filled < frames:
                outdata[filled:, 0] = 0
                if self._current is None and self._queue.empty():
                    self._playing.clear()
