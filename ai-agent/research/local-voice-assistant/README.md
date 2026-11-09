# local-voice-assistant

A fully offline, local speech-to-speech voice assistant in Python. You talk,
it talks back — no cloud services and no network calls at runtime (aside from
Ollama's own HTTP API on localhost).

```
microphone -> VAD -> speech-to-text -> local LLM -> text-to-speech -> speakers
              |                                                          |
              +----------------- barge-in (interrupt) -------------------+
```

All core pipeline stages are built: mic capture with VAD-based turn-taking
(push-to-talk as a fallback), streaming STT, streaming LLM, streaming TTS with
sentence-level chunking, barge-in, and an optional persona overlay.

## Stack

| Stage | Component |
|---|---|
| Voice activity detection | Silero VAD (decides when you've started/stopped talking) |
| Speech-to-text | faster-whisper |
| LLM | Ollama serving `qwen3:8b`, over its local HTTP API |
| Text-to-speech | Kokoro (+ eSpeak NG for out-of-dictionary words) |
| Audio I/O | sounddevice, pynput (push-to-talk key detection) |

## Prerequisites

**Hardware**

- Windows 11 (what this is developed and tested on)
- NVIDIA GPU with **8GB VRAM**, CUDA available
- A microphone, and ideally headphones (see the barge-in note under
  [Configuration](#configuration))

**Software**

- **Python 3.13** — the venv is built with 3.13; 3.12 also works. See the
  `spacy`/`blis` note under [Known gotchas](#known-gotchas) before changing this.
- **[Ollama](https://ollama.com/download)**, installed and running. The
  assistant talks to it at `http://localhost:11434` and does not start it for
  you — `ollama serve` must be up, which the desktop app does automatically.
- **`qwen3:8b` pulled into Ollama** (~5.2 GB):
  ```console
  ollama pull qwen3:8b
  ```

eSpeak NG does **not** need a system install — it ships inside the
`espeakng-loader` wheel from `requirements.txt`.

**First run needs internet (once)**

The STT and TTS weights download automatically from HuggingFace on first use
and cache to `~/.cache/huggingface/hub`:

| Model | Size |
|---|---|
| `Systran/faster-whisper-small.en` | ~464 MB |
| `hexgrad/Kokoro-82M` | ~315 MB |

After that first download, nothing leaves the machine.

**VRAM budget.** 8GB is shared across everything on the GPU at once: `qwen3:8b`
(~5.2 GB) plus faster-whisper plus Kokoro. That's why `config.yaml` defaults to
`small.en` at `int8_float16` rather than a larger model or higher precision.
Keep the combined footprint in mind before changing model sizes or compute
types.

## Setup

```console
git clone <this repo>
cd local-voice-assistant

py -3.13 -m venv .venv
.venv\Scripts\activate

pip install -r requirements.txt
ollama pull qwen3:8b
```

## Usage

Make sure Ollama is running, then:

```console
python main.py
```

It listens continuously and replies when you stop talking. Speak over it to
interrupt (barge-in). `Ctrl+C` to quit.

**Other modes**

| Command | Behaviour |
|---|---|
| `python main.py` | Default. VAD decides when your turn ends. |
| `python main.py --text` | Type instead of talking; replies are still spoken. `/reset` clears history, `/quit` exits. |
| set `push_to_talk: true` in `config.yaml` | Hold **Right Ctrl** to talk, release to send. Useful if VAD misfires in a noisy room. |

While running, a status line shows `IDLE` / `LISTENING` / `THINKING` /
`SPEAKING`, along with per-stage latency timings.

## Configuration

All runtime settings live in `config.yaml`.

| Key | Default | What it does |
|---|---|---|
| `ollama_model` | `qwen3:8b` | Model name as Ollama knows it |
| `ollama_base_url` | `http://localhost:11434` | Where the Ollama server is |
| `whisper_model_size` | `small.en` | Larger = better transcription, more VRAM |
| `whisper_compute_type` | `int8_float16` | Quantization; keep conservative on 8GB |
| `whisper_device` | `cuda` | `cpu` works but is slow |
| `kokoro_voice` | `af_heart` | Kokoro voice id (`a`=American, then `f`/`m` for gender) |
| `push_to_talk` | `false` | `true` swaps VAD for hold-to-talk on Right Ctrl |
| `vad_threshold` | `0.5` | Speech probability 0–1. Lower = more sensitive, more false triggers |
| `silence_threshold_ms` | `700` | How long a pause ends your turn |
| `barge_in` | `true` | Lets you interrupt mid-reply. Set `false` if you're on speakers and the assistant's own voice triggers it |
| `system_prompt` | — | The plain (non-persona) system prompt |
| `persona` | disabled | See below |

Conversation history is capped at the last 12 messages (`MAX_HISTORY` in
`main.py`).

## Persona

An optional character overlay, off by default. With `persona.enabled: false`
behaviour is byte-for-byte identical to the plain system prompt above — same
prompt, same voice, same temperature — so the two are directly A/B-able.

Enable it in `config.yaml`:

```yaml
persona:
  enabled: true
  name: KURT
  voice: am_michael      # overrides kokoro_voice when persona is on
  temperature: 0.88      # overrides the Ollama default when persona is on
  humour: 75             # 0-100
  candor: 90             # 0-100
  profanity: 35          # 0-100
  allow_runtime_adjust: true
```

The character itself — its system prompt, its few-shot examples, and the
wording each dial maps onto — lives in `persona.yaml`, so it can be tuned
without touching Python. The three dials are converted into a described
sentence appended to the prompt ("you swear rarely, and it lands because it's
rare"), since models follow that far better than a bare number.

With `allow_runtime_adjust: true` you can also retune it out loud mid-conversation:

> "set your humour to forty percent" · "turn your candor down" · "set your profanity to ten"

Spoken numbers and both spellings (`humour`/`humor`) are understood. Changes
are in-memory only and never written back to `config.yaml`.

## Project structure

```
local-voice-assistant/
├── assistant/
│   ├── audio.py        # Mic capture: VAD turn-taking, push-to-talk, barge-in
│   ├── stt.py          # faster-whisper transcription
│   ├── llm.py          # Ollama client, streaming chat
│   ├── tts.py          # Kokoro synthesis, speech sanitizer, queued audio player
│   └── persona.py      # Persona loading, dial bands, spoken dial commands
├── main.py             # Entry point; the three run modes and the turn loop
├── config.yaml         # All runtime settings
├── persona.yaml        # Persona prompt, dial band wording, few-shot examples
├── requirements.txt
├── CLAUDE.md           # Instructions for Claude Code
└── README.md
```

## How we build this

- We build in stages, one piece of functionality at a time, and only when
  asked for it.
- Do not implement ahead of what's been asked, and do not add features,
  abstractions, config options, or error handling beyond what was explicitly
  requested.
- Keep changes scoped to the module(s) the task is actually about.

## Known gotchas

Found the hard way — don't regress these.

**`Player` uses one persistent `sd.OutputStream`**, not the simpler
`sd.play()`/`sd.stop()` API. That API shares a module-level "last stream"
reference that races with a producer/consumer queue: `flush()` could call
`sd.stop()` before the playback thread's `sd.play()` had registered itself,
silently doing nothing while the "stopped" audio kept playing. A per-chunk
`sd.OutputStream` was also tried and is unstable — it crashed the process
outright when aborted mid-write from another thread. Don't "simplify" `Player`
back to either.

**`_load_espeak_library()` must run *before* `KPipeline` is constructed.**
misaki (Kokoro's phonemizer) only knows ~89k dictionary words; anything else
gets `phonemes=None`, which would crash the sentence. Kokoro's
`KPipeline.__init__` tries to build an `EspeakFallback` itself but quietly
settles for no fallback if the native library isn't loadable — and misaki only
looks for a system-wide install (`C:\Program Files\eSpeak NG`). Loading the
library first is what makes Kokoro's own attempt succeed. Get the order wrong
and names silently stop being spoken. `_silent_oov_fallback` remains as the
degraded path if eSpeak can't load at all.

**eSpeak NG comes from the `espeakng-loader` wheel, not a system install.** It
bundles `espeak-ng.dll` 1.52.0 and its data (~19 MB unpacked) inside the venv,
needs no admin rights, and has no dependencies of its own, so it can't disturb
the pinned `spacy` subtree. Don't "fix" this by installing eSpeak NG
system-wide.

**`_PRONUNCIATION_OVERRIDES` in `assistant/tts.py` beats both the dictionary
and eSpeak**, for words eSpeak's letter-to-sound rules guess wrong (it reads
"Vivek" as "vye-vek", "Qwen" as "kyoo-wen"). Keys are lowercase and match any
capitalization. Values must use only `misaki.en.US_VOCAB` characters — anything
outside that set crashes the sentence. Note that `EspeakFallback` applies a
`replace('o','ɔ')` step commented "for espeak < 1.52" while the bundled engine
*is* 1.52.0, which is why a few words ("Kokoro") need an override to get their
"oh" vowel back.

**The `spacy`/`thinc`/`blis`/`spacy-curated-transformers`/`curated-tokenizers`/
`kokoro`/`misaki` pins in `requirements.txt` are for real installability
reasons.** Newer `kokoro` releases depend on a `misaki` version never published
to PyPI, and the default resolution for `misaki[en]`'s `spacy` extras pulls a
`blis` with no Python 3.13 wheel (which then tries, and fails, to build from
source). Don't bump these without re-verifying a clean
`pip install -r requirements.txt`.

**Silero VAD requires exactly 512-sample frames at 16kHz** (32ms — not the
literal 30ms sometimes quoted, but the closest the model supports).
`VADRecorder` in `assistant/audio.py` is built around that fixed chunk size.

**The speech sanitizer preserves `...`, `--` and doubled punctuation** on
purpose — they're the prosody controls that make the persona's deadpan
delivery reach the speaker. If you tighten `_UNSPEAKABLE_RE` in
`assistant/tts.py`, the persona will sound identical to the default one no
matter what the prompt says.
