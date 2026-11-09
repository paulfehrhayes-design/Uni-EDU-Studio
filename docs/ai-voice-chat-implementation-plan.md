# AI Voice Conversation Platform — Implementation Plan

**Status:** Living implementation plan. Update this document in the same change whenever the AI voice implementation, architecture, dependencies, scope, or acceptance status changes.

## Goal

Build a general-purpose voice conversation platform for the Unitree G1 EDU. It should listen to a live conversation, maintain a speaker-labeled transcript, understand the discussion, and prepare useful responses. In the first version, a person—not the AI—decides when the robot speaks.

The first application is a debate assistant, but the platform should also support general conversation and future specialized agents without rebuilding audio capture, transcription, or playback for each use case.

## Core principles

1. **Local-first, network-optional:** Core conversation must be usable without internet. When Wi-Fi/internet is available, approved online services may be offered as an explicit option, not silently selected as a fallback. The user must be able to see which processing route is active.
2. **Child-friendly by design:** Every model, agent profile, prompt, knowledge source, and user-facing response path must be appropriate for children in the intended classroom age range. Safety is a system requirement, not just a prompt instruction.
3. **Human-controlled speech:** The system can listen and prepare; in V1 it cannot decide to speak without a person approving playback.
4. **Adapt selectively:** Reuse the strongest suitable ideas and components from the repositories under `ai-agent/research/`, and from other vetted projects when useful. Adapt or directly edit a project checkout for this product when that is clearer than building around it; do not preserve upstream code or features that do not serve the requirements.
5. **Keep the robot safe and existing behavior intact:** Voice AI is a separate service with no V1 motion capability. Integration must not disrupt existing Uni-EDU Studio or DUET operation.

## Living-document requirement

This plan is the source of truth for AI voice scope, architecture, implementation phases, and acceptance criteria. **Every change to AI voice code or its project configuration in the Codespace must include a corresponding update to this document in the same change.** Update affected sections as implementation decisions are made; reflect completed work, changed interfaces/dependencies, test results, known limitations, and revised acceptance gates. Do not leave this as a one-time proposal that drifts from the implementation. If a change is intentionally exploratory and does not alter the plan, record that decision in the change description rather than editing unrelated plan sections.

## V1 scope and boundaries

V1 includes:

- Continuous microphone input and live transcription.
- A complete local processing path for audio capture, transcription, diarization, LLM responses, and TTS, subject to the target hardware's measured capabilities. Where the G1 cannot run the selected models adequately, use a separately hosted local computer on the private network before considering an online service.
- Optional online model/service providers when Wi-Fi/internet is available and the operator explicitly enables them. Network loss must not silently transmit data elsewhere or make the local path unusable.
- Speaker diarization: distinguish voices and assign temporary labels such as **Speaker 1** and **Speaker 2**. This does not identify people by name.
- Conversation history, with the verbatim transcript kept distinct from summaries and AI-generated drafts.
- A general conversation agent and configurable specialized agent profiles, starting with debate mode.
- Child-appropriate, age-aware system behavior and safety handling across all agents and providers.
- Responses generated in the background and presented for review.
- Manual playback, edit/regenerate/dismiss controls, and barge-in that stops the robot's current speech when someone starts speaking or the user presses Stop.
- Text-to-speech playback through a replaceable audio adapter.
- A separate development and deployment environment from the existing Uni-EDU Studio runtime.

V1 explicitly does **not** include:

- Autonomous debate interjection or automatic response playback.
- Camera input, visual speaker identification, or camera-driven behavior.
- LLM-issued locomotion, arm, or other robot-motion commands.
- Voice enrollment or naming/recognizing a person across sessions.
- Model fine-tuning. An agent is initially a configuration (model, instructions, and settings), not a newly trained model.
- Automatic upload of audio, transcripts, or identifiers to online services. Any online processing must be explicitly configured, visible, and limited to the data necessary for that request.

## Architecture

```text
Microphone
  -> audio capture and voice activity detection
  -> streaming speech recognition
  -> speaker diarization
  -> timestamped speaker turns
  -> conversation/session manager
       -> selected agent profile and LLM
       -> response drafts (not transcript entries)
  -> human review: edit / regenerate / dismiss / play
  -> text-to-speech and speaker
       -> playback controller and barge-in
```

Keep the transcript, discussion summary, generated drafts, and actually played robot speech as separate data. Only confirmed playback is recorded as something the robot said. New transcript turns can invalidate or refresh a draft; they must never silently alter the historical transcript.

The conversation manager should maintain:

1. A timestamped transcript with provisional anonymous speaker labels.
2. A rolling discussion summary (positions, claims, evidence, rebuttals, and open questions).
3. The selected agent's private working context and current response draft.
4. An event record for drafts and playback, separate from spoken human turns.

Speaker labels may be provisional and diarization may be uncertain, especially with overlap or noisy rooms. The UI should show uncertainty rather than imply verified identity.

## Isolation and integration strategy

Treat `ai-agent/` as the home for the new service. Its `configs/`, `services/`, `interfaces/`, `integrations/`, `prompts/`, `scripts/`, and `tests/` folders are currently scaffolding; `ai-agent/research/` contains reference material and must not become a runtime dependency.

- Give the voice platform its own Python environment, dependency lock/manifest, configuration, model cache, logs, and start/stop lifecycle. Do not add its heavyweight audio/ML dependencies to the existing backend environment.
- Make local inference the default route and verify that the service starts and operates with network access disabled. Keep required models and dependencies available locally through an intentional install/download workflow; do not make runtime startup depend on reaching model hubs or cloud APIs.
- Treat Wi-Fi as an optional transport, not as permission to use a remote AI provider. Online providers must be separately configured and explicitly enabled, clearly identified in the UI/session state, and governed by a documented data-sharing policy. Never fail over from local to remote processing without an explicit user/operator choice.
- Define a clear local-vs-online capability matrix per component (STT, diarization, LLM, TTS), including what data leaves the device for each online option. Allow components to use different routes only when the operator can understand and approve the resulting data flow.
- Develop and test the service on a separate computer first. Before running models onboard, measure the exact G1 host's available compute and memory while Uni-EDU Studio and robot services are running. Do not assume the documented hardware configuration or benchmark results apply to the target robot.
- Keep it as a separate process/service, not a feature imported into `backend/server.py` or the legacy robot client. The application can later connect through a narrow, versioned interface.
- Prefer a loopback/private service endpoint and an authenticated Uni-EDU backend proxy if the UI needs remote access. Do not expose an unauthenticated model or microphone-control API on the classroom network.
- Make the Uni-EDU interface additive and feature-gated. Preserve legacy robot routes, the DUET v2 path, their settings, and their audio/motion behavior. Voice connection and failure must not change robot ownership or motion execution.
- Provide explicit microphone/session state, start/stop controls, and a clear way to end and delete session data. Default to local processing and no retained raw audio; any remote provider or audio retention must be an explicit, documented configuration choice.
- Minimize collection and retention of children's data. Do not infer or store real names, face/voice identity, precise location, or other sensitive traits. Make recording/listening state visible, provide accessible stop/delete controls, and document who can access saved transcripts and how long they persist.

The hardware integration must use a voice-specific audio adapter. First determine which microphone and speaker interfaces are available on the target G1 and how they are already used. Do not modify or take ownership of the existing robot motion control path to obtain audio.

## Agent and model configuration

Keep the base model separate from an agent profile. An agent profile should define:

- Display name and purpose.
- Model/provider reference and generation settings.
- System instructions and behavioral guidelines.
- Context/summary policy.
- Optional knowledge sources and tools (disabled by default in V1).
- Voice/playback preferences.
- Age range/reading level and a safety policy identifier that can be checked independently of the prompt text.

Start with a general conversation profile and a debate profile. Initially, validate one fully local model/provider combination end-to-end, while keeping the interface replaceable; then benchmark optional online alternatives separately. Add selectable model versions after lifecycle, performance, privacy, and resource behavior are measured. Switching agent profiles must not restart microphone capture or lose the transcript. Switching profiles must clearly indicate whether their conversation context is shared or reset.

### Child-safety requirements

- Define the intended classroom age range with educators before selecting models or writing final agent instructions. Do not claim that generic model safeguards alone make a system child-safe.
- Use age-appropriate language and content. Decline or safely redirect sexual, exploitative, violent, self-harm, illegal, discriminatory, or otherwise age-inappropriate requests; do not provide actionable harmful instructions. Avoid encouraging secrecy, dependency, or emotional exclusivity with the AI.
- Never present the system as a human, a trusted adult, or a substitute for a teacher/guardian. For disclosures involving danger, abuse, self-harm, or urgent distress, respond supportively and direct the child to a trusted adult or the classroom's established safeguarding process; do not promise confidentiality.
- Apply safety checks to both input and generated output, including transcripts, summaries, retrieved documents, and speech output. Test safety behavior for locally hosted and online models independently; a provider switch must not bypass the common application-level policy.
- Keep educator-controlled agent instructions within a safety envelope. Custom agents and knowledge sources must not disable child-safety rules or grant motion/audio recording permissions.
- Provide clear educator oversight, visible AI-generated labeling, a stop control, and reporting/escalation guidance appropriate to the deployment. Do not rely on voice identity or age estimation to decide a child's protections.
- Include privacy, consent, data-retention, and safeguarding review before real classroom use; use synthetic/consented recordings during development.

### Candidates to benchmark, not commitments

Use the existing research checkouts as candidate building blocks and references. Compare their relevant capabilities rather than choosing a single repository wholesale. For each candidate, check current project status, license and model terms, child-safety limitations, privacy/data flow, offline support, hardware compatibility, maintenance burden, and measured performance.

The repositories in `ai-agent/research/` may be studied, adapted, or directly modified for this project where their licenses permit. Keep upstream research checkouts clearly separate from the product implementation. When adopting code, record its upstream URL, pinned commit/version, license/attribution obligations, the parts reused or changed, and why that dependency is needed. Prefer a small maintained fork or focused extraction over copying a whole framework; remove unused demos, services, model integrations, and dependencies from the project-specific runtime when they provide no required capability. Do not delete or rewrite research checkouts merely because a component was not selected; remove only project-owned, demonstrably unused code, and preserve required notices and reproducibility information.

- **Pipeline/framework:** Compare Pipecat's modular real-time pipeline with Hugging Face Speech-to-Speech and other relevant local-first candidates. Reuse the parts that solve concrete needs (streaming, cancellation, transport, component adapters); do not inherit default auto-speaking or cloud assumptions.
- **Speech recognition:** compare faster-whisper and NVIDIA Parakeet variants on the target audio and hardware.
- **Diarization:** compare pyannote.audio and NVIDIA NeMo. V1 needs anonymous speaker clustering, not biometric identification.
- **VAD:** compare Silero VAD with a lighter WebRTC-based option.
- **Speech generation:** compare Kokoro, Qwen3-TTS, and Piper for latency, voice quality, supported hardware, and licensing.
- **LLM:** benchmark compact quantized locally runnable conversational models, including Qwen-family candidates, against at least one alternative. Assess online models only as an optional route. Select based on measured child-safety behavior, latency, quality, memory use, deployment terms, privacy, and offline operation rather than model name alone.

Keep these components replaceable and choose the best-fit components across repositories rather than requiring one repository to provide everything. Maintain one documented interface and common safety/data-handling layer across local and online providers. Do not make a framework's default behavior auto-speak; manual approval is a product-level constraint.

## Implementation phases

### Phase 0 — Discovery and compatibility

- Inspect the target G1's microphone/speaker APIs, audio device availability, current audio users, operating-system environment, and network arrangement.
- Record the exact hardware/firmware and available compute; measure resource headroom with existing Uni-EDU and robot services active.
- Inventory the `ai-agent/` scaffold and research references; map candidate components to concrete requirements and identify what should be reused, adapted, forked, or left as reference. Choose a first pipeline candidate only after checking license, maintenance, model requirements, child-safety limitations, and offline support.
- Define the intended child age range, local/online data-flow policy, consent/retention defaults, and baseline safety tests with educators.
- Verify that the chosen local component set can work without Wi-Fi; specify what optional online components add and what data they receive.
- Define initial latency, transcription-quality, diarization-quality, and resource targets from a baseline recording and hardware benchmark.

**Exit:** A documented audio I/O path, deployment arrangement, child-safety/privacy policy, local/online capability matrix, candidate reuse/adaptation map, and benchmark procedure; no existing robot-control mechanism changed.

### Phase 1 — Standalone desktop voice prototype

- Create the isolated service environment and a repeatable start/stop workflow.
- Verify the selected speech pipeline and configured local model work with network access disabled, and expose when a component is unavailable rather than silently switching providers.
- Implement microphone capture, VAD, live transcription, session start/stop, and a basic transcript view.
- Add timestamped anonymous diarization and visibly represent uncertain/overlapping speech.
- Test from a separate computer without a physical robot or connection to Uni-EDU robot-control APIs.

**Exit:** A local conversation can be captured, transcribed, speaker-labeled, and stopped cleanly without internet access; failures are visible and do not leave audio capture running. Child-safety and data-minimization checks pass for the prototype's supported behavior.

### Phase 2 — Conversation and agent profiles

- Add structured transcript turns, bounded context, and a rolling discussion summary.
- Add the general and debate agent profiles, editable instructions, and a provider/model interface.
- Add common child-safety handling and age-appropriate response checks that apply regardless of the selected agent or local/online model.
- Generate and refresh response drafts as new speech arrives, with a debounce/turn-completion policy to avoid repeatedly querying the model for every partial word.
- Keep drafts and summaries out of the verbatim transcript; show what discussion segment a draft is based on.

**Exit:** The debate agent can produce a relevant, age-appropriate draft from recent discussion while preserving transcript provenance; changing profiles does not reset audio capture or weaken safety policy.

### Phase 3 — Human-controlled speech and interruption

- Add edit, regenerate, dismiss, and explicit Play controls for the current draft.
- Add TTS and a playback state machine with immediate user Stop and barge-in when new speech is detected.
- Handle cancellation across draft generation and TTS so stale output does not start after a newer turn or cancellation.
- Record robot speech only after confirmed playback; distinguish a generated draft from spoken output in the interface and history.

**Exit:** Nothing is spoken without explicit approval. Playback can be stopped reliably, and cancelled/stale responses cannot resume or play later.

### Phase 4 — Isolated G1 audio test

- Implement the G1 microphone/speaker adapter behind the voice service interface.
- Install and run the voice service using its own environment and lifecycle; initially keep it separate from the Uni-EDU backend and all motion services.
- Test start/stop, audio routing, sustained capture, transcript quality, playback, barge-in, disconnect/restart, and resource use with the physical G1 supervised and stationary.
- Verify operation without internet access on the target deployment, with required models already installed. If inference runs on a separate local computer, document the private-network dependency and verify that loss of that host is surfaced without cloud failover.
- Keep motion APIs unavailable to the service. No test in this phase may issue a robot movement command.

**Exit:** A supervised test on the target G1 passes the voice acceptance checklist, and the service can be stopped or removed without changing existing Uni-EDU/DUET behavior.

### Phase 5 — Optional Uni-EDU Studio connection

- Add a separate, feature-gated conversation surface that connects to the voice service through a versioned, authenticated interface.
- Keep conversation session controls and transcript state separate from code execution, robot SDK actions, DUET programs, and classroom queues.
- Test that disabling the feature or stopping the voice service leaves all current application paths unchanged.

**Exit:** The app can start/stop and display a voice session without changing existing robot behavior or requiring changes to the legacy motion protocol.

### Later phases — Explicitly out of V1

Evaluate named-speaker enrollment, camera-based context, suggested interjection timing, autonomous speaking, and robot tools as separate projects with their own consent, privacy, safety, and acceptance reviews. Robot motion must never be enabled merely by adding an LLM tool; it requires a separately designed and validated safety boundary.

## Initial interface and data contracts

Keep the first interface small and versioned. Exact endpoint names can be chosen during implementation.

- Session operations: create/start, status, stop, and delete.
- Agent operations: list profiles and select a profile for a session.
- Live events: transcript partial/final updates, speaker changes/uncertainty, draft status, playback status, and explicit errors.
- Draft operations: edit, regenerate, dismiss, and approve/play a specific draft version.
- Every session/event should carry a session ID and sequence/timestamp so reconnects and late events cannot reorder or replay stale content.
- Expose health and model-readiness separately from robot status. Do not report voice-service readiness as robot connectivity or safety readiness.
- Do not expose motion tools or robot SDK calls in the V1 tool registry.

## Verification and release gates

### Automated tests

- Unit tests for audio/session state transitions, transcript ordering, speaker-label assignment, summary/context boundaries, and draft provenance.
- Tests that generated drafts never enter the human transcript and that only confirmed playback is recorded as robot speech.
- Tests for cancel/stop/barge-in races, stale drafts, reconnects, and service/model errors.
- Tests that local mode makes no unapproved external network/model calls, that loss of internet or the approved local inference host does not trigger cloud fallback, and that optional online routes are only used when explicitly enabled.
- Child-safety evaluations for every supported agent/provider, covering age-appropriate answers, unsafe requests, safeguarding disclosures, prompt injection in transcripts/retrieved material, and attempts to bypass safety through custom instructions.
- Tests that online-provider selection and data flow are visible, remote requests contain only the configured minimum data, and no credentials or sensitive session content are logged.
- Integration tests with recorded audio fixtures for recognition and diarization; report quality metrics and known overlap/noise limitations.
- Service API authentication, malformed input, session isolation, resource cleanup, and feature-disabled behavior tests.
- Uni-EDU regression tests covering existing backend routes, legacy robot controls/audio behavior, and DUET v2 behavior.

### Supervised G1 acceptance

- Confirm target identity, software/model versions, audio device routing, and available resource headroom.
- Confirm microphone/session state is visible and start/stop works; verify no capture continues after stop or service shutdown.
- Run a multi-speaker conversation and review transcript timing, speaker consistency, overlap handling, and uncertainty.
- Confirm the selected agent produces a reviewable draft; verify no automatic playback occurs.
- Play an approved draft, interrupt it by speaking and by pressing Stop, and measure cancellation/stop latency.
- Verify disconnection, model failure, and restart produce visible errors and do not activate robot motion.
- Verify operation without internet access, then separately verify any approved optional online route and confirm the operator can tell which route handled the session. If a separate local inference host is required, test its loss and recovery explicitly.
- Run an extended session while monitoring CPU/GPU/memory, temperature, audio dropouts, and interference with existing robot/app services.
- Confirm transcript/session deletion and configured raw-audio retention behavior.
- Have educators review child-safety behavior, disclosure handling, AI identity disclosure, consent flow, and escalation guidance before classroom use.

Record measured results and unresolved limitations before enabling the optional app surface. Desktop tests, simulators, and model benchmarks alone do not count as G1 audio acceptance.

## Open decisions to resolve during Phase 0

- Which G1 microphone and speaker interfaces are supported by the exact target image, and are they currently used by Uni-EDU or another service?
- Should the first usable interface be a local desktop/web panel, the Uni-EDU Studio UI, or both after the standalone prototype?
- What latency and transcription/diarization quality are acceptable for a classroom debate?
- Should summaries and transcripts persist after a session, and if so, for how long and under whose control?
- What classroom age range and local safeguarding process should the child-safety policy target?
- Which host should run the LLM and speech models after benchmarking: G1 onboard when feasible, or a separately managed local computer on the private network? What minimum functions must remain available on the G1 if that host is offline?
- Which optional online model/provider choices meet the project's child-safety, licensing, privacy, consent, data-retention, and performance requirements?

## Plan maintenance checklist

For every Codespace change that affects this project:

- Update this plan in the same change; do not defer plan updates to a later cleanup.
- Keep the stated scope, actual architecture, dependency/adaptation decisions, and deployment instructions aligned with the code.
- Update phase status and exit criteria only when evidence supports the change; report actual test/hardware results and remaining gaps.
- Preserve the local-first, child-safety, manual-speech-approval, and no-motion boundaries unless a deliberate scope change is reviewed and documented.
- When a repository/component is added, removed, replaced, or directly modified, update the candidate/adaptation record and applicable license/attribution notes.
