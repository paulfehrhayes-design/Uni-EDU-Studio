# Harry Botter Research Folder Audit

## Scope and limits

This is a screening of the 44 top-level project snapshots listed in
[`ai-agent/research/SOURCES.tsv`](../ai-agent/research/SOURCES.tsv). The recorded
commit is the snapshot provenance, not proof of a current upstream release.
The inventory used each folder's top-level README, manifest, license, and
structure; it did not audit every source file or independently verify every
upstream change. Repository licenses do not establish the terms of downloaded
model weights, voice assets, or training data. Re-check exact terms, pins, and
model provenance before deployment.

## Decisions relevant to the desktop voice pipeline

### Feature-level review and selective adaptations

The snapshots contain useful components and operating patterns even when a
whole repository is not an appropriate dependency. The following deeper review
records what the individual features do, whether they fit this application,
and what has been adapted without copying third-party implementation code.

| Snapshot feature | Product value | Disposition |
|---|---|---|
| [ComfyUI-OmniVoice-TTS](../ai-agent/research/ComfyUI-OmniVoice-TTS/) sentence-aware long-form chunking, synthesis speed, cancellation checks between chunks, reusable Whisper/model caches, CPU/device selection, voice design, voice cloning, and multi-speaker generation | Pace and clear completion/cancellation are directly useful for teacher preview. Sentence-boundary chunking helps long passages. Model cache/device controls matter for its diffusion/Qwen3 backbone. Cloning/design and multi-speaker output need separate consent, model terms, and model capability. | Adapted the **speed control concept** to the existing generic Kokoro path: slower/normal/faster teacher choices, API validation to `0.75–1.25`, forwarding the selected speed to Kokoro, and no new model dependency. Preserve the existing request cancellation. Do not copy ComfyUI nodes, its installer, or its code; its installer is designed around ComfyUI's preinstalled PyTorch and explicitly works around OmniVoice's Torch pin. Do not adopt its reference-audio cloning/design, auto-selected voice, or multi-speaker features. Its separate model weights and large diffusion runtime are not installed. |
| [speech-to-speech](../ai-agent/research/speech-to-speech/)'s response latency records, generation revisions, cancellation/queue flush, VAD settlement, and stale-output checks | Teachers need to distinguish transcription wait from local model generation when evaluating the experience; old drafts must not overwrite newer turns. | Existing sequence/session checks, abortable generation, VAD-triggered playback stop, and explicit local errors follow these patterns. Voice-created drafts now show the browser-observed transcript-to-draft elapsed time. This is a user-visible timing aid, not a component-level benchmark. Do not import its provider pipeline or copy its telemetry implementation. |
| [Pipecat](../ai-agent/research/pipecat/)'s cancellable async tools, text aggregation, frame sequencing, and task management | These patterns clarify lifecycle and ordering boundaries, but the preview has no tool calls or incremental LLM tokens. | Keep the small product-owned WebSocket/event implementation. Do not add a framework for unused tools or partial text. Use event sequence numbers to reject stale transcript events and cancel pending work on sign-out. |
| [speech-to-speech](../ai-agent/research/speech-to-speech/)'s streaming diarizer | Provides anonymous, potentially overlapping speaker activity with per-session reset and bounded audio windows, but requires a specific supported model/Transformers combination and inference resources. | No model is licensed/selected for this product and no diarization is enabled. Keep speaker unknown; do not copy this model-dependent component or produce invented speaker labels. Revisit with model provenance, consented audio, accuracy, resource, and privacy evidence. |
| [LocalAI](../ai-agent/research/LocalAI/)'s separated, demand-loaded inference backends | Useful operational concept for minimizing installed components and providing local OpenAI-compatible APIs. | The existing product-owned OpenAI-compatible client already isolates the model server from the app. Keep Ollama as the documented option; do not add a second server or remote-provider failover for this setup. |
| [Kokoro](../ai-agent/research/kokoro/)'s small local generic TTS and speed parameter | Matches short, explicit teacher-approved speech output with a low-resource general model. | Keep the current Kokoro adapter, default generic voice, and local cache; expose a small pace range. Exact weights/voice terms still need release review. |

| Capability | Candidate evidence | Decision |
|---|---|---|
| Streaming orchestration | [Pipecat](../ai-agent/research/pipecat/) is BSD-2-Clause; [Hugging Face Speech-to-Speech](../ai-agent/research/speech-to-speech/) and [LiveKit Agents](../ai-agent/research/agents/) document streaming pipelines, but each includes optional provider/cloud paths. Speech-to-Speech's cancellation generations, stale-output discard/queue flush, VAD-triggered interruption, and bounded diarization worker are useful design patterns. LiveKit also contains a separate model license restricting certain models to LiveKit Agents. | Use the product-owned service and authenticated backend proxy. Reuse the cancellation/event patterns as architecture only; do not add a whole framework or any hosted-provider path. |
| VAD | [Silero VAD](../ai-agent/research/silero-vad/) is MIT-licensed at repository level and supports 512-sample frames at 16 kHz. However, the checked-in model artifacts have no separate license/provenance statement, and the README badge is inconsistent. [FireRedVAD](../ai-agent/research/FireRedVAD/) has Apache-2.0 code but separately downloaded model terms remain to be checked. | Do not bundle either research model yet. Use the small `webrtcvad-wheels==2.0.14.post1` package as the initial VAD candidate (PyPI metadata identifies MIT and Python >=3.10); recheck the package/source notices before release. It operates on short PCM frames and creates no speaker embeddings. |
| STT | [faster-whisper](../ai-agent/research/faster-whisper/) is MIT-licensed code with separate model downloads and CPU INT8 support. The product already has a product-owned local Whisper adapter and explicit cache setup. [NVIDIA NeMo Speech](../ai-agent/research/Speech/) is a broad Apache-2.0 toolkit. | Extend the existing faster-whisper adapter for VAD-bounded utterances. Keep model downloads explicit/offline-capable. Do not add NeMo's broad dependency set without benchmark evidence. |
| Diarization | [pyannote-audio](../ai-agent/research/pyannote-audio/) and [SpeechBrain](../ai-agent/research/speechbrain/) provide local research/toolkit paths, but pretrained model terms, gated downloads, resource use, and privacy behavior require separate review. | No diarization model is selected in this audit. Do not infer identity or persist voice embeddings. Keep anonymous speaker labels visibly unavailable until a suitable local model and educator/privacy review are established. |
| TTS | [Kokoro](../ai-agent/research/kokoro/) is Apache-2.0 code with model/voice terms to review and is already integrated through a product-owned adapter. [Qwen3-TTS](../ai-agent/research/Qwen3-TTS/) includes a 1.7B text-only VoiceDesign model; model-weight terms and accelerator requirements remain separate. [kokoro-tts](../ai-agent/research/kokoro-tts/) is a redundant MIT wrapper. [Piper](../ai-agent/research/piper/) notes development moved to a GPL-3.0 successor and voice licenses vary. OmniVoice exposes speed and chunk-boundary controls, but uses a much heavier model. | Keep Kokoro as the small default and offer opt-in Qwen3 VoiceDesign for a fictional described voice; neither guarantees a particular age/accent. No reference-audio cloning or named-person imitation is supported. Review model terms and target-device quality/resources before deployment. |
| Local LLM | [LocalAI](../ai-agent/research/LocalAI/) is MIT-licensed and exposes an OpenAI-compatible local API, but it is a broad server with optional add-ons and model downloads. The product already has a loopback-only OpenAI-compatible client and an Ollama setup guide. | Keep the current local-compatible interface. Treat LocalAI as an alternative runtime, not a dependency, until measured against the configured local model and offline contract. |

### Folder-by-folder disposition

The linked [`SOURCES.tsv`](../ai-agent/research/SOURCES.tsv) records the source
repository and snapshot commit for each entry.

| Folder | Classification and disposition |
|---|---|
| [VoxNovel](../ai-agent/research/VoxNovel/) | Novel narration/TTS UI; MIT project snapshot, with bundled Tortoise-related and model terms separate. Not a real-time conversation component. |
| [T5Gemma-TTS](../ai-agent/research/T5Gemma-TTS/) | MIT TTS/training code for a large model; model-card terms and hardware requirements separate. Not lightweight. |
| [kokoro-tts](../ai-agent/research/kokoro-tts/) | MIT TTS wrapper; redundant with the existing Kokoro adapter; model/voice terms remain separate. |
| [VibeVoice](../ai-agent/research/VibeVoice/) | MIT code for model-heavy speech research; model-card terms and resource needs separate. Research reference only. |
| [VibeVoice-ComfyUI](../ai-agent/research/VibeVoice-ComfyUI/) | MIT ComfyUI wrapper with separately governed model components; UI-specific and not needed. |
| [Voice-Clone-Studio](../ai-agent/research/Voice-Clone-Studio/) | Apache-2.0 top-level project with independently licensed nested modules and voice-cloning features. Do not import wholesale; its Qwen3 VoiceDesign workflow informed the optional product-owned adapter. |
| [Vocal-Agent](../ai-agent/research/Vocal-Agent/) | MIT real-time assistant; inspect provider/model paths before any component reuse. Existing product adapters make the framework unnecessary. |
| [voice-changer](../ai-agent/research/voice-changer/) | MIT conversion UI with additional CLA/vocoder/Beatrice notices and model terms. Not needed; no imitation use. |
| [Voice-to-text-and-voice-chatbot](../ai-agent/research/Voice-to-text-and-voice-chatbot/) | Whisper/LLM/Groq chatbot; no top-level license found and includes hosted inference. Exclude. |
| [Symposium2023](../ai-agent/research/Symposium2023/) | MIT demo collection with ChatGPT/action/IoT integrations; not a local audio pipeline. |
| [flutter_voice_friend](../ai-agent/research/flutter_voice_friend/) | Flutter app with cloud and on-device paths; CC BY-NC-SA 4.0. Not suitable for product code reuse. |
| [speechbrain.github.io](../ai-agent/research/speechbrain.github.io/) | Documentation/static site; no top-level license found. Not a runtime component. |
| [gemma4-agent](../ai-agent/research/gemma4-agent/) | MIT agent/model example; not a speech component. |
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
| [local-voice-assistant](../ai-agent/research/local-voice-assistant/) | Ollama/Whisper/Kokoro reference with no top-level license found. Architecture/setup reference only; no source reuse. |
| [kokoro](../ai-agent/research/kokoro/) | Apache-2.0 TTS implementation with separate model/voice review; current product adapter already uses Kokoro. |
| [gemma-voice-agent](../ai-agent/research/gemma-voice-agent/) | Voice-agent example with no top-level license found. Do not reuse code. |
| [figaro](../ai-agent/research/figaro/) | GPL-3.0 voice modifier/soundboard; not an agent pipeline and not needed. |
| [faster-whisper](../ai-agent/research/faster-whisper/) | MIT CTranslate2 Whisper implementation; existing product STT adapter already uses it. Model weights remain separately licensed. |
| [CosyVoice](../ai-agent/research/CosyVoice/) | Apache-2.0 streaming TTS with cloning features and separate model terms. Not needed for current generic voice. |
| [coqui-voice-pack](../ai-agent/research/coqui-voice-pack/) | MIT voice asset pack; audio usage/redistribution terms need independent review. Not a speech engine. |
| [bolna](../ai-agent/research/bolna/) | MIT agent framework with provider integrations. Architecture only; not a local-first component. |
| [pipecat-examples](../ai-agent/research/pipecat-examples/) | BSD-2-Clause examples, many cloud/deployment/provider paths. Inspect only local transport patterns. |
| [pipecat-flows](../ai-agent/research/pipecat-flows/) | BSD-2-Clause structured-conversation extension; not an inference component. |

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
