# Harry Botter Research Folder Audit

## Scope and limits

The research directory currently contains 47 project folders. The
[`ai-agent/research/SOURCES.tsv`](../ai-agent/research/SOURCES.tsv) index now
lists all 47; 45 have an upstream snapshot commit recorded, while the
Crawl4AI and SearXNG commit fields are explicitly `UNRECORDED`. The original
folder inventory was a README/manifest/license screening, not an audit of every
source file or a verification of every upstream change. Later sections record
deeper source checks and executed tests, but do not claim every upstream
project has been fully reviewed or tested. Repository licenses do not establish
the terms of downloaded model weights, voice assets, or training data.
Re-check exact terms, pins, and model provenance before deployment.

## Decisions relevant to the desktop voice pipeline

### Feature-level review and selective adaptations

The snapshots contain useful components and operating patterns even when a
whole repository is not an appropriate dependency. The following deeper review
records what the individual features do, whether they fit this application,
and what has been adapted without copying third-party implementation code.

| Snapshot feature | Product value | Disposition |
|---|---|---|
| [VoxNovel](../ai-agent/research/VoxNovel/)'s Tkinter speaker editor: per-line checkboxes, color-coded labels, bulk reassignment to CSV, and a separate continue control | Could let a teacher correct uncertain anonymous speaker labels without pretending automatic diarization is accurate. | Adapted as teacher-only, per-turn correction of anonymous `Speaker N` labels on saved streaming transcripts in group mode. Labels stay with the conversation; the API rejects personal-name labels. No VoxNovel code, Tkinter/CSV/book-processing workflow, or dependency was copied. This is a correction UI, not diarization or speaker identity recognition. |
| [Voice-Clone-Studio](../ai-agent/research/Voice-Clone-Studio/)'s modular Gradio tabs, tool/engine toggles, offline-model setting, manual-save option, and output list with metadata and confirmed deletion | Useful for separating optional capabilities and making generated outputs reviewable and explicitly deletable. | Keep Harry Botter's smaller, purpose-built teacher preview and its human approval before playback. Added a local, teacher-confirmed text export of saved conversations with citations; no Voice-Clone-Studio code, multi-engine UI, model manager, or dependency was copied. The source app is centered on cloning/training, vendors components under distinct licenses, and has substantial CUDA/PyTorch assumptions. |
| [Gemma voice agent](../ai-agent/research/gemma-voice-agent/)'s explicit GPU-waking status, streaming transcript/delta events, and conversation drawer with rename/delete and failed-turn retry | Honest readiness and visible session management reduce confusion when services are slow or a request fails. | Adapted the conversation-rename interaction to Harry Botter's existing teacher-owned local session list; custom titles persist when messages are saved, and the API remains owner-scoped. Existing deletion and draft regeneration controls remain product-owned. The Gemma demo's code is not copied: it is a Cloud Run system using a dedicated GPU service for Gemma 4 31B, and its paper lookup calls OpenAlex. |
| [local-voice-assistant](../ai-agent/research/local-voice-assistant/)'s sentence-chunked TTS, barge-in, latency markers, and history limited to text whose audio playback completed naturally | Useful interruption/accounting semantics for systems that speak automatically. | Harry Botter V1 requires human approval before playback, so it must not treat a generated draft as spoken history. Revisit the confirmed-played-prefix pattern only if automatic speech is later approved. |
| [ComfyUI-OmniVoice-TTS](../ai-agent/research/ComfyUI-OmniVoice-TTS/) sentence-aware long-form chunking, synthesis speed, cancellation checks between chunks, reusable Whisper/model caches, CPU/device selection, voice design, voice cloning, and multi-speaker generation | Pace and clear completion/cancellation are directly useful for teacher preview. Sentence-boundary chunking helps long passages. Model cache/device controls matter for its diffusion/Qwen3 backbone. Cloning/design and multi-speaker output need separate consent, model terms, and model capability. | Adapted the **speed control concept** to the existing generic Kokoro path: slower/normal/faster teacher choices, API validation to `0.75–1.25`, forwarding the selected speed to Kokoro, and no new model dependency. Preserve the existing request cancellation. Do not copy ComfyUI nodes, its installer, or its code; its installer is designed around ComfyUI's preinstalled PyTorch and explicitly works around OmniVoice's Torch pin. Do not adopt its reference-audio cloning/design, auto-selected voice, or multi-speaker features. Its separate model weights and large diffusion runtime are not installed. |
| [speech-to-speech](../ai-agent/research/speech-to-speech/)'s response latency records, generation revisions, cancellation/queue flush, VAD settlement, and stale-output checks | Teachers need to distinguish transcription wait from local model generation when evaluating the experience; old drafts must not overwrite newer turns. | Existing sequence/session checks, abortable generation, VAD-triggered playback stop, and explicit local errors follow these patterns. Voice-created drafts now show the browser-observed transcript-to-draft elapsed time. This is a user-visible timing aid, not a component-level benchmark. Do not import its provider pipeline or copy its telemetry implementation. |
| [Pipecat](../ai-agent/research/pipecat/)'s cancellable async tools, text aggregation, frame sequencing, and task management | These patterns clarify lifecycle and ordering boundaries, but the preview has no tool calls or incremental LLM tokens. | Keep the small product-owned WebSocket/event implementation. Do not add a framework for unused tools or partial text. Use event sequence numbers to reject stale transcript events and cancel pending work on sign-out. |
| [speech-to-speech](../ai-agent/research/speech-to-speech/)'s streaming diarizer | Provides anonymous, potentially overlapping speaker activity with per-session reset and bounded audio windows, but requires a specific supported model/Transformers combination and inference resources. | No pretrained model from this snapshot is selected. Harry Botter currently has a separate provisional spectral grouping heuristic; do not describe that heuristic as model-based diarization or as classroom-validated. Do not copy this model-dependent component until model provenance, consented audio, accuracy, resource, and privacy evidence are available. |
| [LocalAI](../ai-agent/research/LocalAI/)'s separated, demand-loaded inference backends | Useful operational concept for minimizing installed components and providing local OpenAI-compatible APIs. | The existing product-owned OpenAI-compatible client already isolates the model server from the app. Keep Ollama as the documented option; do not add a second server or remote-provider failover for this setup. |
| [Kokoro](../ai-agent/research/kokoro/)'s small local generic TTS and speed parameter | Matches short, explicit teacher-approved speech output with a low-resource general model. | Keep the current Kokoro adapter, default generic voice, and local cache; expose a small pace range. Exact weights/voice terms still need release review. |

| Capability | Candidate evidence | Decision |
|---|---|---|
| Streaming orchestration | [Pipecat](../ai-agent/research/pipecat/) is BSD-2-Clause; [Hugging Face Speech-to-Speech](../ai-agent/research/speech-to-speech/) and [LiveKit Agents](../ai-agent/research/agents/) document streaming pipelines, but each includes optional provider/cloud paths. Speech-to-Speech's cancellation generations, stale-output discard/queue flush, VAD-triggered interruption, and bounded diarization worker are useful design patterns. LiveKit also contains a separate model license restricting certain models to LiveKit Agents. | Use the product-owned service and authenticated backend proxy. Reuse the cancellation/event patterns as architecture only; do not add a whole framework or any hosted-provider path. |
| VAD | [Silero VAD](../ai-agent/research/silero-vad/) is MIT-licensed at repository level and supports 512-sample frames at 16 kHz. However, the checked-in model artifacts have no separate license/provenance statement, and the README badge is inconsistent. [FireRedVAD](../ai-agent/research/FireRedVAD/) has Apache-2.0 code but separately downloaded model terms remain to be checked. | Do not bundle either research model yet. Use the small `webrtcvad-wheels==2.0.14.post1` package as the initial VAD candidate (PyPI metadata identifies MIT and Python >=3.10); recheck the package/source notices before release. It operates on short PCM frames and creates no speaker embeddings. |
| STT | [faster-whisper](../ai-agent/research/faster-whisper/) is MIT-licensed code with separate model downloads and CPU INT8 support. The product already has a product-owned local Whisper adapter and explicit cache setup. [NVIDIA NeMo Speech](../ai-agent/research/Speech/) is a broad Apache-2.0 toolkit. | Extend the existing faster-whisper adapter for VAD-bounded utterances. Keep model downloads explicit/offline-capable. Do not add NeMo's broad dependency set without benchmark evidence. |
| Diarization | [pyannote-audio](../ai-agent/research/pyannote-audio/) and [SpeechBrain](../ai-agent/research/speechbrain/) provide local research/toolkit paths, but pretrained model terms, gated downloads, resource use, and privacy behavior require separate review. | No pretrained diarization model is selected. The product currently has a provisional session-local spectral grouping heuristic; it is not speaker-embedding diarization and has no real-speaker accuracy evidence. Do not infer identity or persist voice embeddings. Keep labels provisional until a suitable model and educator/privacy review are established. |
| TTS | [Kokoro](../ai-agent/research/kokoro/) is Apache-2.0 code with model/voice terms to review and is already integrated through a product-owned adapter. [Qwen3-TTS](../ai-agent/research/Qwen3-TTS/) includes a 1.7B text-only VoiceDesign model; model-weight terms and accelerator requirements remain separate. [kokoro-tts](../ai-agent/research/kokoro-tts/) is a redundant MIT wrapper. [Piper](../ai-agent/research/piper/) notes development moved to a GPL-3.0 successor and voice licenses vary. OmniVoice exposes speed and chunk-boundary controls, but uses a much heavier model. | Keep Kokoro as the small default and offer opt-in Qwen3 VoiceDesign for a fictional described voice; neither guarantees a particular age/accent. No reference-audio cloning or named-person imitation is supported. Review model terms and target-device quality/resources before deployment. |
| Local LLM | [LocalAI](../ai-agent/research/LocalAI/) is MIT-licensed and exposes an OpenAI-compatible local API, but it is a broad server with optional add-ons and model downloads. The product already has a loopback-only OpenAI-compatible client and an Ollama setup guide. | Keep the current local-compatible interface. Treat LocalAI as an alternative runtime, not a dependency, until measured against the configured local model and offline contract. |

### Folder-by-folder disposition

The linked [`SOURCES.tsv`](../ai-agent/research/SOURCES.tsv) records the source
repository and snapshot commit for each entry.

| Folder | Classification and disposition |
|---|---|
| [VoxNovel](../ai-agent/research/VoxNovel/) | MIT batch audiobook workflow: BookNLP attribution, a Tkinter per-line speaker correction editor, multi-character TTS, and audiobook export. Startup imports can download BookNLP model archives; processing also fetches NLTK data and invokes Calibre. Only the anonymous per-turn correction concept was adapted to Harry Botter; no code or workflow was copied. It is not a real-time conversation backend; model and nested terms remain separate. |
| [T5Gemma-TTS](../ai-agent/research/T5Gemma-TTS/) | MIT TTS/training code for a large model; model-card terms and hardware requirements separate. Not lightweight. |
| [kokoro-tts](../ai-agent/research/kokoro-tts/) | MIT TTS wrapper; redundant with the existing Kokoro adapter; model/voice terms remain separate. |
| [VibeVoice](../ai-agent/research/VibeVoice/) | MIT code for model-heavy speech research; model-card terms and resource needs separate. Research reference only. |
| [VibeVoice-ComfyUI](../ai-agent/research/VibeVoice-ComfyUI/) | MIT ComfyUI wrapper with separately governed model components; UI-specific and not needed. |
| [Voice-Clone-Studio](../ai-agent/research/Voice-Clone-Studio/) | Apache-2.0 top-level Gradio application with independently licensed nested modules, modular tabs, model downloads, output history, and voice cloning/training. Its useful review/settings patterns are UX references only; do not import wholesale. Its startup can rewrite installed Torch Inductor source to patch a platform issue, and it assumes a large CUDA/PyTorch stack. |
| [Vocal-Agent](../ai-agent/research/Vocal-Agent/) | MIT real-time assistant; inspect provider/model paths before any component reuse. Existing product adapters make the framework unnecessary. |
| [voice-changer](../ai-agent/research/voice-changer/) | MIT conversion UI with additional CLA/vocoder/Beatrice notices and model terms. Not needed; no imitation use. |
| [Voice-to-text-and-voice-chatbot](../ai-agent/research/Voice-to-text-and-voice-chatbot/) | Whisper/LLM/Groq chatbot; no top-level license found and includes hosted inference. Exclude. |
| [Symposium2023](../ai-agent/research/Symposium2023/) | MIT demo collection with ChatGPT/action/IoT integrations; not a local audio pipeline. |
| [flutter_voice_friend](../ai-agent/research/flutter_voice_friend/) | Flutter app with cloud and on-device paths; CC BY-NC-SA 4.0. Not suitable for product code reuse. |
| [speechbrain.github.io](../ai-agent/research/speechbrain.github.io/) | Documentation/static site; no top-level license found. Not a runtime component. |
| [gemma4-agent](../ai-agent/research/gemma4-agent/) | MIT local terminal agent using Ollama `/api/chat`, NDJSON token streaming, a bounded tool loop, and optional Whisper/Gemma audio. Its README recommends Gemma 4 26B for chat or 12B for native audio; these are model tags, not included weights. The tool registry includes shell/Python execution and file writes, so it is not a suitable drop-in for a classroom draft assistant. Focused mocked/unit tests are recorded below. |
| [speechbrain](../ai-agent/research/speechbrain/) | Apache-2.0 toolkit; pretrained model and download terms vary. Diarization candidate only after model/compute review. |
| [pcc-groq-llama](../ai-agent/research/pcc-groq-llama/) | Hosted Groq voice web/phone starter; no top-level license found. Exclude hosted path. |
| [Vocal-Agent__tarun7r](../ai-agent/research/Vocal-Agent__tarun7r/) | MIT cascading agent with local Whisper/Silero/Ollama/Kokoro pieces plus web tools. Existing product adapters are preferable; no framework import. |
| [agents](../ai-agent/research/agents/) | LiveKit Agents, Apache-2.0 framework with separate restrictive `MODEL_LICENSE` for certain LiveKit models. Architecture only; do not use those models. |
| [moshi-finetune](../ai-agent/research/moshi-finetune/) | Apache-2.0 fine-tuning code; Moshi model/data terms still apply. Not a runtime adapter. |
| [piper](../ai-agent/research/piper/) | MIT historical repository; development moved to a GPL-3.0 successor and voice-model terms vary. No voice selected. |
| [Qwen3-VL](../ai-agent/research/Qwen3-VL/) | Apache-2.0 vision-language model repository; out of scope for voice-only preview. |
| [Qwen3-TTS](../ai-agent/research/Qwen3-TTS/) | Apache-2.0 TTS code with separately governed model weights and multiple capabilities, including an optional 1.7B text-only VoiceDesign teacher-preview adapter. Its weights are not installed by default and need terms/hardware/audio acceptance. Voice cloning is not used. |
| [ComfyUI-OmniVoice-TTS](../ai-agent/research/ComfyUI-OmniVoice-TTS/) | Apache-2.0 ComfyUI wrapper. Its speed, sentence chunking, model caching, and interrupt checks are useful feature references; the pace concept is adapted in the product-owned Kokoro adapter/UI. Do not use its ComfyUI installer, diffusion model, voice cloning/design, or multi-speaker generator. |
| [FireRedVAD](../ai-agent/research/FireRedVAD/) | Apache-2.0 VAD code; separately downloaded model weights need terms review. Alternative benchmark only. |
| [vc-lm](../ai-agent/research/vc-lm/) | Voice-conversion research code with no top-level license found. Do not reuse. |
| [svoice](../ai-agent/research/svoice/) | CC BY-NC-SA 4.0 voice-separation research model with dated CUDA/PyTorch setup. Non-commercial/share-alike restriction makes it unsuitable. |
| [speech-to-speech](../ai-agent/research/speech-to-speech/) | Apache-2.0 local speech pipeline with optional provider paths. Reuse cancellation, stale-output, and bounded-worker design patterns only. |
| [Speech](../ai-agent/research/Speech/) | NVIDIA NeMo Speech, Apache-2.0 broad toolkit. Architecture reference; no dependency selected. |
| [silero-vad](../ai-agent/research/silero-vad/) | MIT repository; model artifacts lack independent terms/provenance and README badge is inconsistent. Do not bundle model weights pending clarification. |
| [pyannote-audio](../ai-agent/research/pyannote-audio/) | MIT toolkit; local models require separate gated/model-term and resource review; hosted premium processing is excluded. |
| [pipecat](../ai-agent/research/pipecat/) | BSD-2-Clause orchestration framework with local and hosted service support. Use transport/component-boundary ideas only; avoid framework dependency. |
| [OpenVoice](../ai-agent/research/OpenVoice/) | MIT voice-conversion/cloning project with separate model terms. Named-person imitation is out of scope. |
| [OmniVoice](../ai-agent/research/OmniVoice/) | Apache-2.0 TTS code; model/voice terms separate. No clear benefit over Kokoro. |
| [moshi](../ai-agent/research/moshi/) | Python MIT/Rust Apache-2.0 real-time speech model; model weights CC-BY 4.0 and L4-class performance claims. Too resource-heavy for this environment. |
| [LocalAI](../ai-agent/research/LocalAI/) | MIT local model server with OpenAI-compatible APIs and broad optional backends. Runtime alternative only; no dependency selected. |
| [local-voice-assistant](../ai-agent/research/local-voice-assistant/) | Unlicensed CLI reference combining VAD, faster-whisper, local Ollama, and Kokoro. Its sentence chunking, barge-in, and completed-playback history are useful patterns, but its README requires an 8-GB GPU and a separately running/pulled Ollama model. No source reuse. |
| [kokoro](../ai-agent/research/kokoro/) | Apache-2.0 TTS implementation with separate model/voice review; current product adapter already uses Kokoro. |
| [gemma-voice-agent](../ai-agent/research/gemma-voice-agent/) | Unlicensed Cloud Run voice agent with a Flask/HTML chat UI, per-user ADK conversation sessions, streaming events, and explicit GPU wake/readiness. It requires a dedicated GPU running Gemma 4 31B and uses OpenAlex for paper lookup; not a local-first drop-in. No top-level license file was found. |
| [figaro](../ai-agent/research/figaro/) | GPL-3.0 voice modifier/soundboard; not an agent pipeline and not needed. |
| [faster-whisper](../ai-agent/research/faster-whisper/) | MIT CTranslate2 Whisper implementation; existing product STT adapter already uses it. Model weights remain separately licensed. |
| [CosyVoice](../ai-agent/research/CosyVoice/) | Apache-2.0 streaming TTS with cloning features and separate model terms. Not needed for current generic voice. |
| [coqui-voice-pack](../ai-agent/research/coqui-voice-pack/) | MIT voice asset pack; audio usage/redistribution terms need independent review. Not a speech engine. |
| [bolna](../ai-agent/research/bolna/) | MIT agent framework with provider integrations. Architecture only; not a local-first component. |
| [pipecat-examples](../ai-agent/research/pipecat-examples/) | BSD-2-Clause examples, many cloud/deployment/provider paths. Inspect only local transport patterns. |
| [pipecat-flows](../ai-agent/research/pipecat-flows/) | BSD-2-Clause structured-conversation extension; not an inference component. |
| [crawl4ai](../ai-agent/research/crawl4ai/) | Apache-2.0 async Playwright crawler (snapshot version 0.9.5). The ordinary in-process library has no egress policy; its Docker server adds the audited DNS-pinning egress proxy and redirect checks. Harry Botter now calls the authenticated Docker API for at most two validated SearXNG results, with a 3.5-second page timeout and bounded response size. The launcher uses `unclecode/crawl4ai:0.9.5@sha256:0b05666882bfb67f45d559a5b827839c54127b74aedd723f8ab338a3571b5fc9`, publishes only on loopback, and creates a local API token. It skips an uncached image pull unless at least 2 GiB of memory and 4 GiB of Docker storage are available. The source snapshot's upstream commit remains unrecorded; the license requires prominent attribution in distributions. |
| [searxng](../ai-agent/research/searxng/) | AGPL-3.0 Flask metasearch service, separate from the product backend. The launcher creates private settings enabling JSON and binds the container to loopback. Automatic startup uses `searxng/searxng:2026.11.21-c6ee3e9fd@sha256:fc1d81d7e9d04d3c8b3e23c7162feddf5c3d6aecd32e67a56eaabcb8d8747f79`. The source snapshot's upstream commit remains unrecorded. |

## Source and runtime follow-up — 2026-11-23

The original inventory above was a screening, not a deep audit of every
upstream source file or a claim that every standalone project had passed its
own test suite. This follow-up examined the active product paths, compared
them with the relevant repository implementations, and exercised the local
stack without sending classroom content to a remote model. It is still
incomplete as a per-file audit of all 47 folders; their full test suites are
not interchangeable, and several require separate GPU environments, model
access, or cloud credentials.

### Source-level checks and runnable-project tests

- **Gemma4 agent:** inspected the Ollama backend, orchestrator, tool registry,
  voice capture, package metadata, and tests. The architecture has useful
  ideas—token streaming, bounded tool iterations, duplicate-call suppression,
  and explicit approval hooks—but it is a terminal agent with shell, Python,
  filesystem, screenshot, and internet tools. The approval callback is
  optional at the registry API, so copying the tool loop would expand Harry
  Botter's authority and is not justified by this preview's workflow.
- **Gemma4 tests:** 8 backend tests, 10 agent-loop tests, and 10 focused local
  tool tests passed (28 total). Model calls and the grounding tool response
  were mocked; no Gemma weights or live Gemma inference were used. The
  internet-dependent skill/search tests and screenshot test were not run.
- **Crawl4AI:** source inspection confirmed Playwright `page.goto` follows
  navigation redirects, and its own `egress_policy.py` says plain library use
  has no egress policy; the checked-in Docker server supplies a pinning proxy.
  The Docker proxy resolves once, rejects non-global IPs, dials the pinned
  address, and revalidates each redirect/request through the browser proxy.
  Its focused offline broker/proxy tests passed below. The product now uses
  that API rather than importing Crawl4AI into the backend process: requests
  use a generated bearer token, are sent to the loopback-published service,
  and contain one URL at a time from the already-filtered SearXNG results.
  Docker, credentials, API, or network failure leaves the SearXNG snippets
  intact; without SearXNG, ordinary local chat continues without web context.
  The image is pinned by multi-platform manifest digest. The repository
  snapshot's source commit remains unrecorded and must not be inferred from
  the image tag.
- **SearXNG:** source inspection confirmed `/search` is a metasearch endpoint,
  JSON output must be enabled in settings, and its limiter depends on Valkey
  when enabled. The app launcher generates settings with JSON enabled and
  publishes the container only on `127.0.0.1`; the automatically managed
  container uses a version tag and verified immutable manifest digest. A
  manually configured local SearXNG endpoint remains supported. The source
  snapshot's upstream commit remains unrecorded even though the runtime image
  is pinned.
- **Local Docker resources:** the existing SearXNG container's image digest
  matches the pinned SearXNG manifest, although its container configuration
  still refers to the `latest` tag and will be recreated with the pinned
  reference by the launcher. This host had about 3 GiB of free Docker storage
  and 1.3 GiB of available memory, below the new Crawl4AI startup thresholds;
  its 2.27 GB image was not pulled or launched. The launcher therefore keeps
  page extraction optional here rather than risking disk exhaustion or memory
  pressure.
- **Interface snapshots:** VoxNovel's main Tkinter flow connects BookNLP
  attribution to a separate color-coded speaker editor; individual edits are
  written to its working CSV, not to a conversational transcript store. Its
  import path can download a BookNLP model archive, and startup/process paths
  download NLTK resources and invoke Calibre, so it was not launched. Harry
  Botter now supports teacher-only correction of anonymous speaker labels on
  individual saved streaming turns in group mode, with API validation against
  personal-name labels. This changes neither transcript text nor model context,
  and does not add diarization or identity recognition. Saved teacher
  conversations can also be exported as a user-confirmed local text download
  containing message roles and available citations; it omits raw audio,
  session IDs, and credentials. Voice-Clone-Studio's
  Gradio app factory and settings provide
  modular tabs, capability toggles, an offline-model option, manual-save
  preference, and output playback/metadata/deletion confirmation. However,
  it centers on cloning/training, includes separately licensed nested
  components, assumes substantial CUDA/PyTorch resources, and rewrites
  installed Torch Inductor source at startup for a compatibility patch; its
  code is not suitable to copy. Its sole integration test initializes
  DeepFilterNet and applies patches, so it was not run.
- **Gemma voice-agent UI:** inspected the static chat page, Flask routes, ADK
  session code, and test guide. It makes model readiness explicit, streams
  transcript/status/text events, and offers conversation rename/delete,
  retry, and rewind. Its local development identity defaults to a single
  `dev` user unless IAP identity is configured; deployed use depends on the
  documented private Cloud Run/GPU setup. The project requires Gemma 4 31B
  on a dedicated GPU and sends paper-search queries to OpenAlex, so its
  persistence/readiness patterns were reviewed without launching the demo.
  Harry Botter now adapts the rename interaction through its own teacher-only,
  owner-scoped API and local UI; no Gemma demo code or cloud identity behavior
  was copied. The smoke and cold start scripts target a running service and
  GPU deployment; neither was run.
- **Local voice CLI:** source inspection confirms sentence-boundary TTS
  chunking, an interrupt event that closes the LLM stream and flushes queued
  audio, and history limited to the naturally completed playback prefix.
  Those semantics matter if Harry Botter later speaks autonomously; in V1,
  the teacher must approve playback, and generated drafts remain distinct
  from speech actually played.
- **Test selection:** faster-whisper's upstream `test_utils.py` calls
  `download_model("tiny")`, and its tokenizer tests instantiate `WhisperModel`
  with model IDs. Qwen3-TTS's example tests exercise model-loading paths.
  Those suites were not run because they would download/load model weights;
  no new model assets were fetched for this audit.
- **Realtime framework comparison:** the current Pipecat source uses a
  `PipelineWorker` for frame lifecycle, cancellation, heartbeat, and idle
  monitoring; its `PipelineTask` module is now a deprecated compatibility
  shim. LiveKit's `Agent` composes STT/VAD/LLM/TTS and turn/interruption
  policies, but the workspace contains a large provider-plugin matrix and a
  separate restrictive model license. Hugging Face Speech-to-Speech contains
  valuable generation-based cancellation, stale-output suppression,
  speculative turn tracking, and per-stage latency records, but its package
  requires Python 3.11+ and a large Torch/Transformers/audio stack with many
  optional backends. These are architecture references, not drop-in
  dependencies for the small product-owned WebSocket service.
- **VAD and speaker models:** FireRedVAD exposes stateful CPU streaming VAD
  (`detect_frame`/`detect_chunk`) over 25 ms windows at a 10 ms hop. Its README
  reports about 588k parameters (~2.2 MB of float32 parameters), not the full
  checkpoint size; `model.pth.tar` and `cmvn.ark` must be supplied separately.
  The checked-in `from_pretrained` loads the checkpoint with
  `torch.load(weights_only=False)`, so only trusted model files are appropriate.
  `FireRedStreamVad.from_pretrained` also uses a shared mutable default config,
  while `set_mode` mutates that config; repeated default constructions can
  inherit a prior mode. This is a source-level concern, not a runtime test
  result. The README's reported benchmark was not independently reproduced,
  and says its annotated test set will be released later. Silero v6.2.3
  bundles JIT and ONNX model files, but its package has a hard
  `torch>=1.12` dependency; `model.py` also sets Torch's process-wide thread
  count to one. Although its sequence ONNX module is torch-free, importing the
  package still imports Torch. The repository-level MIT license does not
  resolve the bundled model artifact provenance. Pyannote's
  `community-1` pipeline combines segmentation, embeddings, PLDA, and
  clustering; the README requires accepting model-hub conditions and using a
  token for its pretrained model. Its code also initializes telemetry as
  enabled by default (`PYANNOTE_METRICS_ENABLED=1`), exporting model/pipeline
  origin and class plus processed-audio duration and requested speaker counts
  to `otel.pyannote.ai`; the documented opt-out is
  `PYANNOTE_METRICS_ENABLED=0`. The README describes these metrics as
  anonymous, but the default outbound telemetry is still unsuitable for an
  unreviewed child-audio integration. The premium pipeline sends audio to a
  hosted service. In SpeechBrain, `Speech_Emotion_Diarization` labels emotion
  over time; it does not identify speakers. The separate AMI speaker
  diarization recipe uses ECAPA-TDNN embeddings and spectral clustering, but
  its sample configuration assumes AMI annotations, oracle VAD, and oracle
  speaker counts and downloads a pretrained embedding checkpoint; it is a
  research recipe rather than a turnkey local product component. Even the
  toolkit's pure edit-distance tests import the top-level package, which
  eagerly imports Torch, so those utilities cannot be exercised without its
  Torch runtime. None was substituted for the current lightweight VAD or
  provisional speaker heuristic.
- **Model-heavy voice projects:** Qwen3-TTS source provides separate
  CustomVoice, VoiceDesign, and reference-audio voice-clone APIs; its
  `from_pretrained` loads model and processor weights and the clone path
  accepts reference audio. VibeVoice's current snapshot includes 7B long-form
  ASR and a 0.5B realtime TTS model, but its repository states the prior TTS
  code was removed after misuse reports. Moshi is a full-duplex two-audio
  stream model with a 7B temporal transformer and its README calls for a
  24-GB GPU for the PyTorch path. These projects do not meet the current
  memory, generic-voice, consent, or deployment constraints; no model weights
  were downloaded.
- **Other snapshots:** the folder-by-folder table above remains a disposition
  inventory, not evidence that each repository's full source or test suite
  was executed. Do not interpret the existing product tests as upstream
  acceptance tests for Pipecat, LiveKit, Ollama, LocalAI, NeMo, SpeechBrain,
  pyannote, Qwen3, or the other snapshots.

### What the model-named folders actually contain

| Repository | Concrete contents and relationship to Harry Botter |
|---|---|
| [Qwen3-TTS](../ai-agent/research/Qwen3-TTS/) | Speech-generation model code and APIs, not a text-chat model. Harry Botter has a separate, opt-in Qwen3 VoiceDesign adapter; the Qwen weights, Python extra, and accelerator requirement are separate from normal startup. |
| [Qwen3-VL](../ai-agent/research/Qwen3-VL/) | Vision-language model code, training utilities, and examples. Harry Botter currently has no image/video model request path, so this repository cannot improve text-only web-grounded drafts without a separately designed feature and model. |
| [gemma-voice-agent](../ai-agent/research/gemma-voice-agent/) | A standalone self-hosted voice-agent design with its own UI, services, and deployment assumptions (including a large Gemma model on a dedicated GPU service). It is not a library backend that can be dropped into the teacher preview. Its top-level snapshot has no license file, so copying its code is not cleared. |
| [gemma4-agent](../ai-agent/research/gemma4-agent/) | A standalone local terminal agent with its own Ollama connection and tool loop. It is not a Gemma weight directory or a Harry Botter UI/backend component; its terminal-agent tools and interaction model are outside the student-facing, teacher-reviewed draft boundary. |
| [Ollama](../ai-agent/research/ollama/) and [LocalAI](../ai-agent/research/LocalAI/) | Inference-server source code and model-format/backend support. Parser templates or gallery YAML entries for Qwen/Gemma describe compatibility or downloads; they are not the model weights. Harry Botter uses its existing loopback Ollama client rather than running a second inference server. |
| [T5Gemma-TTS](../ai-agent/research/T5Gemma-TTS/), [Gemma voice-agent](../ai-agent/research/gemma-voice-agent/), and other Gemma-named examples | Speech/agent examples or training and inference code with distinct model requirements. The name alone does not mean a Gemma chatbot is installed or wired into Harry Botter. |

Ollama's live `/api/tags` response in this environment listed only
`qwen3:0.6b` (Q4_K_M, about 523 MB). That is the one installed chat model;
the model picker can only select models exposed by the configured model
server. No Gemma chat model was pulled or benchmarked in this audit.

### Component-level findings and decisions

- **LLM routing:** the product-owned local client already uses Ollama's native
  local chat API, bounded prompts, selected model IDs, and explicit local
  readiness. The real model and live-search draft smoke checks succeeded.
  LocalAI or the complete agent frameworks would add another runtime or tool
  layer without evidence of lower latency or better answers. No research
  framework is being added as a runtime dependency.
- **Knowledge retrieval:** the teacher-managed local reference library is
  filtered by permission confirmation, selected IB level, selected agent, and
  review date before retrieval. The active voice-service path now uses
  BM25-style lexical ranking with term rarity, chunk-length normalization,
  and a bounded metadata boost rather than raw term counts. Focused tests
  verify that a focused passage can outrank one that repeats a generic query
  term and that stopword-only queries return no context. This improves
  ordering but does not prove a source is accurate or authoritative; semantic
  retrieval and educator-reviewed relevance evaluation remain open.
- **Search and retrieval:** the existing SearXNG query plus Crawl4AI extraction
  path was exercised against live results; the local model generated a draft
  with returned source links. Existing backend tests cover empty/unavailable
  search fallback and source forwarding. Those live crawler checks preceded
  the switch to Docker and exercised the former in-process path; they do not
  verify the new container/API runtime. The new API contract, fallback paths,
  and pinned image manifests are covered by focused tests and registry
  inspection, but a live Docker crawl was not run for this change. The search
  service remains an explicitly separate pre-retrieval step; retrieved text
  is untrusted context, not verified fact or a model tool with unrestricted
  browsing.
- **Speech input:** the product uses `faster-whisper` for CPU transcription,
  WebRTC VAD for 20 ms frames, bounded utterances, and session-local adaptive
  speaker grouping. It does not use a pyannote, SpeechBrain, NeMo, Silero, or
  FireRed model. The checked-in `AdaptiveSpeakerTracker` uses simple spectral
  features, not a validated speaker-embedding model; synthetic unit tests do
  not establish accuracy on real speakers, overlap, or classroom noise. Keep
  its labels provisional and anonymous.
- **Speech output:** the active generic TTS path is Kokoro. A real request
  through the running voice API produced valid 24 kHz WAV audio; a local
  Kokoro-to-Whisper synthetic round trip recovered the test phrase. The
  optional Qwen3-TTS feature remains gated and is not required for normal
  chat. Voice-cloning and celebrity-imitation projects remain excluded.
- **User interfaces and orchestration:** the standalone interfaces reviewed
  have different login, persistence, deployment, and tool-execution
  assumptions. No whole UI or agent loop was copied. The product keeps its
  existing authenticated teacher preview, manual playback approval, bounded
  context, and cancellation/session controls; only feature-level patterns
  compatible with those contracts are adapted.

### Tests and live checks performed

| Scope | Command or check | Result |
|---|---|---|
| Ollama installer | `node --test scripts/ollama-install.test.js` | 2 passed |
| Gemma4 local agent | Focused `test_backends.py`, `test_agent.py`, and selected local `test_tools.py` cases | 28 passed; mocked model/grounding, no Gemma weights |
| Voice API | `cd ai-agent/voice-service && PYTHONPATH=src python -m unittest discover -s tests -p test_api.py -v` | 21 passed |
| Local model client | `cd ai-agent/voice-service && PYTHONPATH=src python -m unittest discover -s tests -p test_local_llm.py -v` | 21 passed |
| Streaming/VAD/speaker grouping | `cd ai-agent/voice-service && PYTHONPATH=src python -m unittest discover -s tests -p test_streaming.py -v` | 7 passed; speaker tests use synthetic/fake audio |
| Search and backend forwarding | `cd backend && python -m unittest test_web_research test_harry_botter_api.HarryBotterAPITests.test_current_draft_forwards_live_web_context_to_the_voice_service` | 7 passed |
| Authenticated Crawl4AI API and fallback | `cd backend && python -m unittest test_web_research` | 11 passed, including bearer auth, two-URL cap, response-size cap, missing-token behavior, and fallback |
| Knowledge retrieval ranking | `cd ai-agent/voice-service && PYTHONPATH=src python -m unittest tests.test_api` | 23 passed, including BM25-style relevance and no-term retrieval regressions |
| Pinned research-service launch configuration | `node --test scripts/web-research-services.test.js` | 3 passed; image pins, loopback configuration, and crawler resource gates verified |
| Docker image manifests | `docker manifest inspect` for both pinned image references | Both immutable manifests verified; live Crawl4AI startup was skipped because local resources are below the configured gates |
| Local model and search | Live SearXNG query, Crawl4AI page extraction, then a Qwen draft with source links | Successful; one request during initial model load returned 503, a later warmed request succeeded |
| Offline STT | Load cached Whisper on generated silence with `HF_HUB_OFFLINE=1` | Model loaded; silence produced no transcript |
| Offline TTS/STT | Generate Kokoro WAV and submit it to local Whisper | Exact synthetic test phrase recovered |
| Audio stream lifecycle | Loopback WebSocket start, PCM frames, stop | Passed; this does not test a physical microphone |
| Crawl4AI config tests | `python -m pytest ai-agent/research/crawl4ai/tests/test_config_defaults.py -q` | 60 passed, 1 deprecated-`proxy` warning |
| Crawl4AI egress broker/proxy | `python -m pytest ai-agent/research/crawl4ai/deploy/docker/tests/test_security_egress_proxy.py ai-agent/research/crawl4ai/deploy/docker/tests/test_security_ssrf_egress.py -q` | 40 passed using fake DNS and local sockets; no live target network |
| Crawl4AI proxy credential redaction | `python -m pytest ai-agent/research/crawl4ai/tests/test_http_proxy_error_redaction_2326.py -q` | 14 passed with a closed local port |
| Speech-to-Speech timing tests | `python -m pytest ai-agent/research/speech-to-speech/tests/test_turn_latency.py -q` | 20 passed; pure state/latency tests, no model inference |
| SearXNG settings loader | `python -m pytest tests/unit/test_settings_loader.py -q` from `ai-agent/research/searxng` | 10 passed; deprecation warnings from the upstream async test helper on Python 3.14 |
| Silero VAD iterator | `PYTHONPATH=ai-agent/research/silero-vad/src python -m pytest ai-agent/research/silero-vad/tests/test_vad_iterator.py -k False -q` | 3 passed using the bundled JIT model on CPU; Python 3.14 emitted a Torch JIT support deprecation warning |
| Silero optional dependencies | `PYTHONPATH=ai-agent/research/silero-vad/src python -m pytest ai-agent/research/silero-vad/tests/test_optional_deps.py -k 'test_import_does_not_pull_optional_packages or test_lazy_sequence_attributes_still_resolve or test_vad_runs_without_any_audio_backend' -q` | 3 passed, including VAD on silence without an audio backend |
| Silero sequence ONNX parity | `PYTHONPATH=ai-agent/research/silero-vad/src python -m pytest ai-agent/research/silero-vad/tests/test_sequence_parity.py -q` | 31 passed across bundled WAV/Opus/MP3 fixtures and post-processing settings; one Python 3.14 Torch JIT warning |
| Pyannote utilities | `cd ai-agent/research/pyannote-audio && PYANNOTE_METRICS_ENABLED=0 PYTHONPATH=src python -m pytest tests/utils/test_powerset.py tests/utils/test_permutation.py tests/utils/test_diarization.py -q` | 8 passed on synthetic tensors/annotations; no models loaded, telemetry disabled; warning that TorchCodec audio decoding is unavailable without FFmpeg shared libraries |
| Silero empty-audio chunks | `PYTHONPATH=ai-agent/research/silero-vad/src python -m pytest ai-agent/research/silero-vad/tests/test_basic.py::test_collect_chunks_without_speech -q` | 1 passed after audit-environment cleanup |
| SpeechBrain utilities | `PYTHONPATH=ai-agent/research/speechbrain python -m pytest ai-agent/research/speechbrain/tests/unittests/test_edit_distance.py ai-agent/research/speechbrain/tests/unittests/test_seed.py -q` | 7 passed; utility tests only, no model inference |

These focused upstream tests used pytest 9.2.0 in a session-local Python 3.14
virtual environment. Only test/runtime imports needed for the selected cases
were installed there; repository dependency manifests were not changed. This
does not imply that each project's complete suite was installed or run.

For this continuation, CPU-only PyTorch 2.11.0 and torchaudio 2.11.0 were
installed in the session-local audit environment, along with the dependencies
needed for the selected SpeechBrain, Silero, and pyannote tests. The research
snapshot lacks its own VCS version metadata, so its test-only installation
used a synthetic `0.0.0.dev0` package version; no repository dependency
manifest was changed. An initial unconstrained installation tried to resolve
CUDA-enabled PyTorch packages and ran out of disk space. Those specific
download-cache files and partial CUDA packages were removed; a CPU-pinned
retry succeeded, `pip check` passed, and 3.0 GiB was free afterward. The
Silero tests used bundled JIT/ONNX models, and the pyannote tests ran with
`PYANNOTE_METRICS_ENABLED=0`; no external model weights or gated services
were fetched. Pyannote's utility tests do not exercise audio-file decoding,
which remains unavailable in this environment because TorchCodec cannot load
without FFmpeg shared libraries. FireRedVAD has no matching unit-test files in
this snapshot.

The Python 3.12 audio environment was bootstrapped and installed with the
project's existing audio extra, CPU PyTorch, Whisper/Kokoro dependencies, VAD,
and WebSocket support. The launcher then started the voice service, warmed
Qwen and Kokoro, and reported transcription, speech generation, and streaming
available. A separate duplicate Kokoro process exited with SIGTERM while the
managed service was running; synthesis through the managed service succeeded.
The host has 7.8 GiB RAM, no swap, and limited free memory under the running
stack, so model loading should remain serialized and no larger model should be
assumed to fit.

**Not performed:** the full test suite of every upstream snapshot, tests that
download/load model weights (including the faster-whisper and Qwen3-TTS
examples noted above), GPU/cloud deployments, gated model downloads, licensed
voice auditions, a real human multi-speaker evaluation, and physical
microphone/speaker or G1 acceptance.
The above product tests validate integration plumbing and synthetic behavior,
not model quality, child-safety, classroom accuracy, or deployment approval.

## Deferred checks

- Recheck package, model, voice, and nested-license notices at the exact versions
  selected for deployment.
- Establish explicit model provenance/terms for a local diarization system
  before adding voice embeddings or speaker clustering.
- Benchmark latency, accuracy, CPU/RAM use, and noisy-room behavior on the
  intended desktop with synthetic or consented audio. This Codespace has no
  physical audio-device acceptance evidence.
- Keep cloud APIs, voice cloning, and camera input out of the teacher preview.
  Teacher-confirmed G1 speech output exists separately in the product through
  the existing TtsMaker adapter; it has not received physical speaker
  acceptance. G1 microphone capture and all motion capability remain outside
  the implemented voice path.
