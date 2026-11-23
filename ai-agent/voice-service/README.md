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
requested pace to 0.75–1.25 before forwarding it to Kokoro. Browser settings
offer a small set of generic presets (`af_heart`, `af_bella`, `af_nicole`,
`am_michael`, `bm_fable`, and `bm_george`). The `bm_` voices use Kokoro's
British English pipeline; they are not Fulham-specific or verified as child
voices. A candidate must be previewed and played before it can be applied to
future browser replies. These are model presets, not celebrity impersonations;
no voice cloning is used. `HARRY_BOTTER_TTS_VOICE` defaults to `af_heart`.
An optional Qwen3-TTS VoiceDesign preset can be enabled to attempt a fictional
youthful South London voice from text instructions, without a reference voice
sample. The model cannot guarantee a particular age or Fulham-area accent.
This 1.7B model is opt-in and requires a supported accelerator by default; the
Voice Clone Studio reference recommends an 8 GB+ CUDA GPU. Its actual voice
quality and hardware requirements have not been accepted on the target device.
This does not change the separate G1 SDK speaker path. Review voice-generation
terms before school deployment. See Kokoro's
[published voice inventory](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md).
Voice-generated
drafts also show the browser-observed time from transcript receipt to draft
response. That timing includes the app/backend request and is not an isolated
model benchmark.

No model weights are bundled. HTTP recordings are bounded temporary files;
streaming PCM and transcript events are kept only in memory and are not
persisted. Agent profiles and attributed knowledge documents remain in the
teacher-authenticated application database and are passed to the service only
for the current draft. Shared behavior-section guidance is also read from that
database for every new draft, so teacher changes affect the next request without
training the model. Knowledge documents can be categorized by behavior section,
agent, and IB stage; current content has a version counter and digest, not a
historical content archive. Excerpts are treated as untrusted reference data,
and expired references are excluded.

Streaming currently emits final utterance transcripts, not partial tokens.
Speaker diarization and speaker identity are not implemented. When the live
VAD detects a new speech onset, the preview stops any explicitly playing
browser TTS reply; this behavior has automated coverage but is not yet
validated with physical audio devices. Stop closes the browser microphone/audio
graph and ends the active stream; any current utterance is finalized before
the service returns its stopped event. Speech playback is teacher-preview
only and requires explicit user action. A separate teacher-confirmed G1
TtsMaker output path is available in Uni-EDU Studio, but it has not been
verified on a physical robot. The voice service remains loopback-only and has
no motion capability or G1 microphone capture.
Do not use the preview with students; prompt rules are not a child-safety
guarantee. Do not claim current CAIS facts or policy unless an approved,
attributable reference is included.

## Teacher conversation and review workflows

The authenticated application backend stores teacher-only conversation text in
its local SQLite database until the owning teacher clears or deletes it. A
conversation is capped at 500 messages and 1 MB of text; the full history is
stored, but only the most recent 12 turns are sent to the model. Deleting a
conversation also deletes its related advisory safeguarding alerts. The text
database is not encrypted at rest. Raw audio is not retained.

The teacher preview includes a classroom activity planner that creates an
editable draft in the selected conversation; it does not update shared behavior
or agent settings. It also offers a policy/source comparison proposal using up
to three approved, current, in-scope references. At most the first 2,500
characters from each selected source are sent to the configured model. The
proposal includes source notes, potential conflicts, and questions for the
educator. It is not automatically saved or treated as approved; the teacher
must review, copy it into the behavior editor, and explicitly save it. A
teacher's explicit confirmation is still required for approval-gated school
context and safeguarding sections. Model-generated comparisons and citations
are not verified facts.

Safeguarding signals are limited phrase-pattern matches for possible self-harm,
abuse, and immediate danger. They are advisory only, visible to the owning
teacher, and do not send email or other external notifications. Signals can
miss disclosures or flag ordinary discussion; they do not replace a staffed,
educator-approved safeguarding process. This application remains a teacher
preview only, not a student chat or a dependable school safeguarding system.

The API is unauthenticated and must remain bound to loopback. Do not expose it
to a LAN, classroom network, reverse proxy, or browser application. The preview
uses the existing teacher-authenticated Uni-EDU backend to proxy all requests;
the browser never calls this service directly.
When the app is hosted by Codespaces, browser audio travels to the remote
workspace over its authenticated connection; run the app, backend, and service
on the same local computer for on-device-only audio processing.

### Model verification status

A previous Codespace run verified a Qwen3 0.6B completion, Kokoro WAV synthesis,
and a synthetic WebRTC VAD/Whisper turn using CPU PyTorch 2.7.1, faster-whisper
1.1.0, and Kokoro 0.7.4. One synthetic transcript had a minor first-word error;
this is inference-plumbing evidence, not a human-speech quality benchmark.

The current development runner has no Ollama binary, `.venv-audio312`, cached
speech models, or `/dev/snd` devices. Model files and Python environments are
not committed. Follow the setup steps below to install and cache them on the
target host; model and voice terms still require deployment review.

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
model and generic Kokoro preset caches. The first pulls require internet;
inference afterward stays on the machine:

```bash
cd ai-agent/voice-service
export HF_HOME="$PWD/models/huggingface"
export OLLAMA_MODELS="$PWD/models/ollama"
ollama pull qwen3:0.6b
source .venv/bin/activate
PYTHONPATH=src python -m harry_botter_voice.setup_models
```

For the optional Qwen3 VoiceDesign voice, install the extra and explicitly
download/load its model before enabling the preset. The first setup needs a
network connection to the Hugging Face model repository; use the same `HF_HOME`
as the service. By default, setup requires CUDA or Apple Silicon MPS. CPU use
can be forced with `HARRY_BOTTER_QWEN_TTS_DEVICE=cpu`, but is not recommended
for this 1.7B model.

```bash
cd ai-agent/voice-service
pip install -e ".[audio,voice-design]"
export HF_HOME="$PWD/models/huggingface"
source .venv/bin/activate
PYTHONPATH=src python -m harry_botter_voice.setup_voice_design
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
# Uncomment only after installing and setting up the optional Qwen model:
# export HARRY_BOTTER_ENABLE_QWEN_VOICE_DESIGN=1
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

For the integrated application, run `npm start` from the repository root. This
launches the backend, voice service, and local Ollama server together, installs
the default model when needed, and warms it before reporting the app ready.
`npm run dev` starts the same services with the Vite development frontend.
`npm run dev:frontend` starts only Vite and requires the backend and AI services
to be started separately. On the first launch, Ollama and its model require
internet access to install; later launches reuse the local installation. If
model setup fails, the app remains available but reports that AI chat is
unavailable. Audio package installation or model download failures are also
reported and do not prevent typing chat when Ollama is ready.

The teacher AI draft chat lists models currently installed on the configured
loopback or private Wi-Fi OpenAI-compatible servers. **Use selected model**
changes the model for the running voice-service process; set
`HARRY_BOTTER_LOCAL_MODEL` or the corresponding network model variables in
`.env.harry-botter.local` to make that selection the startup default.

### Optional live web research

Current-information questions (for example, those asking for the latest news,
today's weather, or current prices) use SearXNG when it is available. The app
manager starts a local SearXNG container on `127.0.0.1:8080` when Docker is
available, generates a private settings file under the ignored
`.searxng-runtime/` directory, and enables JSON search. Set
`HARRY_BOTTER_SEARXNG_URL` in `.env.harry-botter.local` to use another local or
trusted private-network instance; configuring another URL skips local container
startup.

The app manager also tries to install Crawl4AI from
`ai-agent/research/crawl4ai/` into the backend's Python environment when that
checkout exists, and installs the Playwright Chromium browser when needed.
These setup steps are optional: install, browser, Docker, SearXNG, or internet
failures are logged and do not prevent normal chat. The backend uses SearXNG
result snippets when available and enriches up to two results with Crawl4AI
when its package and browser runtime are ready.
On Linux hosts missing Chromium system libraries, install them with
`sudo python -m playwright install-deps chromium` in the same Python environment
used by the backend. The launcher checks whether Chromium can actually start
and falls back to SearXNG snippets when it cannot.

Live searching is limited to queries that appear to ask for current information.
The query is sent to the configured SearXNG instance, which may forward it to
its selected search engines. Retrieved web text is treated as untrusted context,
is not independently verified, and is shown with source links and retrieval
dates. The local model remains the only answer generator.

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
bind addresses are deliberately not configurable. The LLM client uses an OpenAI-compatible API. By default, its endpoint is
loopback-only; a separately configured private-network endpoint can be selected
before the loopback model as an explicit Wi-Fi route, with the local model as
fallback. It never uses a hosted provider. Proxy environment variables are
ignored. The audio stream starts only when its optional runtime dependencies
are available.

## API v1

- `GET /api/v1/health` — reports service readiness and explicitly lists
  capabilities that are not implemented.
- `GET /api/v1/model/status` — reports whether a local model is configured,
  reachable, and listed by the local runtime; includes installed models from
  configured local and private-network routes.
- `POST /api/v1/model/select` — selects a model ID only after confirming it is
  listed as installed by the configured provider.
- `GET /api/v1/speech/status` — reports whether the optional local speech
  packages are installed and which Whisper model/voice are configured,
  the curated generic voice presets,
  and whether streaming dependencies are ready. Missing package names are
  included to help diagnose incomplete audio setup.
- `WS /api/v1/audio-stream` — loopback-only audio stream, selected only through
  the teacher-authenticated Uni-EDU backend proxy. The browser sends the
  `pcm_s16le_mono` start message at 16 kHz, followed by 640-byte 20 ms binary
  frames, then a `stop` control message. Ordered events include speech start,
  final transcript, speech end, errors, and stopped. The stream rejects
  browser-origin requests and does not provide diarization.
- `POST /api/v1/transcribe` — accepts a bounded WebM, Ogg, MP4, or WAV
  utterance and returns an English transcript without retaining the audio.
- `POST /api/v1/speech` — accepts short text, optional speed, and an available
  curated Kokoro or enabled Qwen3 VoiceDesign voice ID; returns a locally
  generated WAV.
- `POST /api/v1/drafts` — accepts a bounded text prompt, optional selected
  IB stage, one of five teacher-preview tones, recent user/assistant text
  history, a validated agent profile, shared behavior-section guidance, and
  up to three attributed knowledge excerpts supplied by the authenticated
  backend. The common system policy is service-owned; custom system prompts and
  unknown fields are rejected. Editable guidance is supplemental and cannot
  replace the common safety policy; reference excerpts are explicitly untrusted.
  If no stage is selected, the service returns a fixed stage question without
  calling a model. With a stage selected, an unconfigured or unavailable model
  remains an explicit error; there is no remote fallback.
- `POST /api/v1/policy-review` — accepts one behavior section and one to three
  approved reference excerpts from the authenticated backend and returns a
  structured, educator-review proposal. The excerpts are treated as untrusted
  data; malformed model output is an explicit error. This endpoint does not
  save or approve policy.
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
