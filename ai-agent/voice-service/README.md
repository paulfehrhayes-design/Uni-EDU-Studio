# Harry Botter Voice Service

This is the isolated, product-owned service foundation. Research checkouts in
`ai-agent/research/` are references, not runtime dependencies. The `local-voice-assistant`
checkout informed the Ollama + Whisper + Kokoro pipeline choice; its code was
not copied, and its README's default 8 GB GPU configuration is not used.

## Current status

The implementation provides local text drafts, turn-based transcription, and
an explicitly started live voice session. A browser AudioWorklet downmixes and
resamples microphone audio to 16 kHz mono PCM, then sends 20 ms frames through
the teacher-authenticated backend to a loopback WebSocket service. WebRTC VAD
segments utterances in memory (bounded to 20 seconds); local faster-whisper
transcribes each segment and the app generates a reviewable draft. The teacher
can explicitly synthesize a draft with local Kokoro and press Play. Typing chat
and the separate microphone/speaker test remain available.
Voice replies offer Slower, Normal, and Faster pace choices; the service bounds
requested pace to 0.75–1.25 before forwarding it to Kokoro. Voice-generated
drafts also show the browser-observed time from transcript receipt to draft
response. That timing includes the app/backend request and is not an isolated
model benchmark.

No model weights are bundled. HTTP recordings are bounded temporary files;
streaming PCM and transcript events are kept only in memory and are not
persisted. Agent profiles and attributed knowledge documents remain in the
teacher-authenticated application database and are passed to the service only
for the current draft. Knowledge excerpts are treated as untrusted reference
data, and expired references are excluded.

Streaming currently emits final utterance transcripts, not partial tokens.
Speaker diarization and speaker identity are not implemented. When the live
VAD detects a new speech onset, the preview stops any explicitly playing
browser TTS reply; this behavior has automated coverage but is not yet
validated with physical audio devices. Stop closes the browser microphone/audio
graph and ends the active stream; any current utterance is finalized before
the service returns its stopped event. Speech playback is teacher-preview
only and requires explicit user action. Robot audio integration remains
outside scope. The service remains loopback-only and has no motion capability.
Do not use the preview with students; prompt rules are not a child-safety
guarantee. Do not claim current CAIS facts or policy unless an approved,
attributable reference is included.

The API is unauthenticated and must remain bound to loopback. Do not expose it
to a LAN, classroom network, reverse proxy, or browser application. The preview
uses the existing teacher-authenticated Uni-EDU backend to proxy all requests;
the browser never calls this service directly.
When the app is hosted by Codespaces, browser audio travels to the remote
workspace over its authenticated connection; run the app, backend, and service
on the same local computer for on-device-only audio processing.

### Codespace model verification

This Codespace now has a local, ignored model cache under `models/`:

- Ollama `0.40.16` with `qwen3:0.6b` (522 MB; Ollama reports Apache-2.0).
- `Systran/faster-whisper-tiny.en` and Kokoro's English `af_heart` voice in the
  Hugging Face cache (about 388 MB combined at setup time).
- CPU PyTorch `2.7.1+cpu`, faster-whisper `1.1.0`, and Kokoro `0.7.4` are
  installed in the ignored workspace `.venv-audio312`.

Verified an actual Qwen completion through the product's local OpenAI-compatible
client, Kokoro WAV synthesis, and an end-to-end synthetic speech turn through
WebRTC VAD and Whisper. The test transcript had a minor first-word recognition
error, so this is evidence that local inference runs—not a speech-quality or
human-microphone benchmark. This Codespace has no physical audio devices. Model
and voice terms still require deployment review; model files and Python
environments are not committed.

## Install local models

The reference assistant uses Qwen3 8B, Whisper small, and Kokoro and documents
an 8 GB NVIDIA GPU setup. This project defaults to the smaller Qwen3 0.6B,
Whisper `tiny.en` with CPU INT8, and Kokoro's generic `af_heart` voice so the
stack can be tried without a GPU. CPU generation may be slow. The exact model
and voice terms must be reviewed before any school deployment; celebrity voice
cloning or imitation is not supported.

Use Python 3.12 for the optional audio dependencies. Install Ollama from its
official [Linux installation instructions](https://ollama.com/download/linux),
then run these commands from the repository root in a Bash-compatible shell:

```bash
cd ai-agent/voice-service
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.7.1
python -m pip install -e ".[audio]"
mkdir -p models/huggingface models/ollama
export HF_HOME="$PWD/models/huggingface"
export OLLAMA_MODELS="$PWD/models/ollama"
```

The `models/` directory is ignored by Git. Keep weights there (or in another
private local cache); do not commit model files. In one terminal, start Ollama
with the same model-store setting:

```bash
export OLLAMA_MODELS="$PWD/models/ollama"
ollama serve
```

In another terminal, pull the small local LLM and explicitly warm the speech
model caches. The first pulls require internet; inference afterward stays on
the machine:

```bash
cd ai-agent/voice-service
export HF_HOME="$PWD/models/huggingface"
export OLLAMA_MODELS="$PWD/models/ollama"
ollama pull qwen3:0.6b
source .venv/bin/activate
PYTHONPATH=src python -m harry_botter_voice.setup_models
```

After setup, use offline mode and start the service:

```bash
export HF_HOME="$PWD/models/huggingface"
export HF_HUB_OFFLINE=1
export OLLAMA_MODELS="$PWD/models/ollama"
export HARRY_BOTTER_LOCAL_MODEL=qwen3:0.6b
export HARRY_BOTTER_LOCAL_MODEL_URL=http://127.0.0.1:11434/v1
export HARRY_BOTTER_WHISPER_MODEL=Systran/faster-whisper-tiny.en
export HARRY_BOTTER_STT_DEVICE=cpu
export HARRY_BOTTER_STT_COMPUTE_TYPE=int8
export HARRY_BOTTER_STT_CPU_THREADS=2
PYTHONPATH=src python -m harry_botter_voice --port 8765
```

Set these variables in the same terminal that starts the service. Run the
Uni-EDU backend and open `/?try=harry-botter` in a full browser tab. Select
**Voice conversation**, choose a learning stage and microphone, and start the
session. Recognized turns automatically produce local drafts; review them and
select **Prepare spoken reply**, then press Play. Nothing is spoken
automatically. Use **Stop voice conversation** to close the microphone and
finish the current utterance. Typing chat and the separate device test are
available from the mode selector.

Without audio dependencies, the text draft service still runs and reports
speech-specific setup errors explicitly. The service does not download speech
models at startup and has no cloud fallback. `HF_HUB_OFFLINE=1` prevents
Hugging Face network access after the explicit warm-up step.

## Run the service

The base text-only service requires Python 3.10 or later. See above to install
the optional audio extra and model caches for voice turns.

```bash
cd ai-agent/voice-service
python3 -m venv .venv
source .venv/bin/activate
PYTHONPATH=src python -m harry_botter_voice --port 8765
```

The HTTP and optional audio-stream services bind to `127.0.0.1` only. Their
bind addresses are deliberately not configurable. The local LLM URL is
restricted to loopback and proxy environment variables are ignored. The audio
stream starts only when its optional runtime dependencies are available.

## API v1

- `GET /api/v1/health` — reports service readiness and explicitly lists
  capabilities that are not implemented.
- `GET /api/v1/model/status` — reports whether a local model is configured,
  reachable, and listed by the local runtime.
- `GET /api/v1/speech/status` — reports whether the optional local speech
  packages are installed and which Whisper model/voice are configured,
  including whether the streaming dependencies are ready.
- `WS /api/v1/audio-stream` — loopback-only audio stream, selected only through
  the teacher-authenticated Uni-EDU backend proxy. The browser sends the
  `pcm_s16le_mono` start message at 16 kHz, followed by 640-byte 20 ms binary
  frames, then a `stop` control message. Ordered events include speech start,
  final transcript, speech end, errors, and stopped. The stream rejects
  browser-origin requests and does not provide diarization.
- `POST /api/v1/transcribe` — accepts a bounded WebM, Ogg, MP4, or WAV
  utterance and returns an English transcript without retaining the audio.
- `POST /api/v1/speech` — accepts short text and returns a WAV generated by
  the configured local Kokoro voice.
- `POST /api/v1/drafts` — accepts a bounded text prompt, optional selected
  IB stage/tone, recent user/assistant text history, and a validated agent
  profile plus up to three attributed knowledge excerpts supplied by the
  authenticated backend. The common system policy is service-owned; custom
  system prompts and unknown fields are rejected. Agent instructions cannot
  replace the common safety policy, and reference excerpts are explicitly
  untrusted. If no stage is selected, the service returns a fixed stage
  question without calling a model. With a stage selected, an unconfigured or
  unavailable model remains an explicit error; there is no remote fallback.
- `POST /api/v1/sessions` — creates an in-memory session.
- `GET /api/v1/sessions/{session_id}` — reads session state.
- `POST /api/v1/sessions/{session_id}/start` — starts a session lifecycle.
- `POST /api/v1/sessions/{session_id}/stop` — stops a running session.
- `DELETE /api/v1/sessions/{session_id}` — deletes a session.

Session state and browser chat history are not persisted by the service.
HTTP audio requests are processed from bounded temporary files and removed
after transcription. Live PCM is buffered in memory only, limited to a
20-second utterance, and cleared after transcription. The service does not
persist audio, transcripts, or source documents and does not accept robot
commands. Explicit model/dependency errors are returned if a local component
is unavailable.

## Tests

```bash
cd ai-agent/voice-service
PYTHONPATH=src python -m unittest discover -s tests -v
```

The Uni-EDU backend must also be running for the teacher preview's model-status
and draft endpoints. Backend requests require an authenticated teacher account.
