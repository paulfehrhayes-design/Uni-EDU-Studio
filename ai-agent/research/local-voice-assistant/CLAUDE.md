# voice-assistant

## Goal

A fully offline, local speech-to-speech voice assistant in Python:
microphone -> speech-to-text -> local LLM -> text-to-speech -> speakers.
No cloud services, no network calls at runtime.

## Stack

- **VAD**: Silero VAD (endpointing — decides when the user has stopped talking)
- **STT**: faster-whisper
- **LLM**: Ollama, serving `qwen3:8b`, over its local HTTP API
- **TTS**: Kokoro
- **Audio I/O**: sounddevice

## Hardware constraints

- Windows 11, Python 3.12, NVIDIA GPU with **8GB VRAM**, CUDA available.
- 8GB VRAM is shared across everything running on the GPU at once: Ollama's
  `qwen3:8b`, faster-whisper, and Kokoro. `qwen3:8b` alone takes a sizeable
  chunk of that budget, so STT/TTS model sizes and compute types must be
  chosen conservatively (e.g. smaller Whisper models, int8/float16 compute
  types) rather than defaulting to the largest or highest-precision option.
- Always keep the combined VRAM footprint of loaded models in mind when
  changing model sizes, compute types, or adding anything else that touches
  the GPU.

## How we build this

- We build in stages, one piece of the pipeline at a time, and only when
  asked for that stage.
- Do not implement ahead of the current stage, and do not add features,
  abstractions, config options, or error handling beyond what was explicitly
  asked for.
- Keep changes scoped to the module(s) the current stage is about
  (`assistant/audio.py`, `assistant/stt.py`, `assistant/llm.py`,
  `assistant/tts.py`, wired together in `main.py`).
