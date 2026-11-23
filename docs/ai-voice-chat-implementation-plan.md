# Harry Botter AI Voice Conversation Platform — Implementation Plan

**Status:** Living implementation plan. Update this document in the same change whenever the AI voice implementation, architecture, dependencies, scope, or acceptance status changes.

## Goal

Build a general-purpose voice conversation platform for the Unitree G1 EDU, whose conversational name is **Harry Botter**. It should respond when addressed by that name, listen to a live conversation, maintain a speaker-labeled transcript, understand the discussion, and prepare useful responses. In the first version, a person—not the AI—decides when the robot speaks.

The first application is a debate assistant, but the platform should also support general conversation and future specialized agents without rebuilding audio capture, transcription, or playback for each use case.

## Core principles

1. **Local-first, network-optional:** Core conversation must be usable without internet. When Wi-Fi/internet is available, approved online services may be offered as an explicit option, not silently selected as a fallback. The user must be able to see which processing route is active.
2. **Child-friendly by design:** Every model, agent profile, prompt, knowledge source, and user-facing response path must be appropriate for children in the intended classroom age range. Safety is a system requirement, not just a prompt instruction.
3. **Human-controlled speech:** The system can listen and prepare; in V1 it cannot decide to speak without a person approving playback.
4. **Adapt selectively:** Reuse the strongest suitable ideas and components from the repositories under `ai-agent/research/`, and from other vetted projects when useful. Adapt or directly edit a project checkout for this product when that is clearer than building around it; do not preserve upstream code or features that do not serve the requirements.
5. **Keep the robot safe and existing behavior intact:** Voice AI is a separate service with no V1 motion capability. Integration must not disrupt existing Uni-EDU Studio or DUET operation.
6. **School-appropriate in every mode:** Every response must be suitable for a school setting. The learner's selected IB programme/stage controls vocabulary, detail, and topic suitability across general and custom agents; it does not weaken the common child-safety policy.
7. **Friendly, recognizable robot persona:** The robot identifies itself honestly as Harry Botter, responds to that name, and may use restrained robot-perspective humor without pretending to be human or distracting from learning.

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
- Child-appropriate, IB-stage-aware system behavior and safety handling across all agents and providers, with a session setting for Early Years, PYP, MYP, or DP.
- Consistent school-appropriate tone settings, English-language-learner support, and a friendly Harry Botter persona.
- Optional school context from educator-approved Changchun American International School materials, subject to the local-first and privacy constraints below.
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

## Learner, school, and persona settings

These are shared conversation settings, not agent-specific prompt conveniences. They must be available to the general, debate, and future custom agents and enforced by the common application-level safety/context layer. Custom agents may add specialization, but cannot override these settings or the school-appropriateness boundary.

### IB programme/stage selection

- Before a session starts, provide an educator/user-visible programme selector using **Early Years, PYP, MYP, and DP** with grade specific PYP 1-5, MYP 1-5 and DP 1-2.  IB programmes names shoul be used. They not map cleanly to a single grade slider; the UI may use a slider-like control only if it represents the selected programme and any educator-approved year/level within it accurately.
- Make the stage selectable in chat settings before the conversation begins. If none is selected, Harry Botter should greet the learner and then ask which grade they are in before giving substantive educational or debate responses. Do not silently guess from voice, appearance, or conversation.
- Use the selected stage to adapt both **how** and **what** the robot discusses: vocabulary, sentence structure, explanation length, assumed background knowledge, conceptual depth, examples, and age/maturity suitability of topics and source material.
- Topic suitability is a separate decision from reading level. For example, discussion of a text with mature themes such as *Of Mice and Men* may be appropriate in an educator-selected DP context, but must not be surfaced or discussed in the same way with an Early Years/PYP learner. Respect the educator's curriculum and classroom context; do not treat selection of a higher stage as permission to provide otherwise unsafe content.
- For the same subject, explain at the selected depth: an Early Years/PYP explanation of changes of state should use familiar, concrete examples, while a DP chemistry discussion may use particle models, terminology, and greater scientific detail.
- If stage is changed during a session, apply it to subsequent drafts and clearly indicate the change. Do not retroactively alter the transcript or previously played speech.
-Allow database for file uploading for grade specific work or classroom context to help inform models answers.

### English-language learners and language roadmap

- Start with English as the supported conversation language. Use clear, natural English; avoid unnecessarily idiomatic, culturally specific, or dense phrasing. Adapt vocabulary, sentence complexity, pace, and explanation style to the selected IB stage and the learner's expressed needs.
- When useful, explain unfamiliar terms in plain English, offer a short rephrasing or example, and invite the learner to ask for clarification without making assumptions about proficiency or identity. Do not infer or store a learner's English ability as a personal trait.
- Keep language selection separate from programme/stage and agent selection so additional languages can be added later without redesigning profiles. Any later language must receive its own transcription, safety, and age-appropriateness evaluation before being enabled.

### Tone and Harry Botter persona

- Provide a tone control before the chat starts, available to every agent. The baseline options are **Formal** and **Lightly humorous**. The teacher preview also exposes **Warm and encouraging**, **Curious/Socratic**, and **Concise** presets for evaluation. All remain friendly, clear, respectful, and school-appropriate; humor should be occasional, brief, and never at a learner's expense. Additional presets are not approved for student use until educator review.
- In both initial tones, Harry Botter can explain its perspective as a G1 robot and make modest robot-related observations or puns (for example, relating its age to a software update or its "birthday" to leaving the factory). Do not overuse jokes, claim human experiences, or let persona override accuracy or safety.
- Use the name **Harry Botter** consistently and respond when addressed by that name. Also can respond to other clear associations like robot, G1, and the like. Clearly disclose that it is an AI-powered robot, not a person or a school authority.
- Allow for database to upload information about Harry Botter as a robot.
- Use the Ai-agent folder tools to attempt to imitate Daniel Radcliffe's voice. Allow a few other suitable voices that can be switched to in settings and tested before setting as the used voice. Select alternative voices before deployment tune qualities (such as clarity, warmth, pace, and energy). Some alternatives could be other celebraties whom have a regonizable voice or tone like Morgan Freeman, Jeff Goldblum, ... . Generic voices can also be given as options. Searching online and cloning voice repositories or samples is allowed to complete this task.

### Changchun American International School context

- School-specific context is an optional, educator-approved knowledge source, not a reason to access student records or assume access to school systems. Begin with public school information or materials explicitly supplied and approved by the school.
- Prefer a locally stored, versioned and attributable knowledge pack for offline use. Record each source, owner/permission, version or review date, and intended use. Keep student-identifiable or confidential school data out of the voice knowledge base unless a separately approved privacy design explicitly requires it.
- Make it clear when an answer uses school-specific context. Treat retrieved material as untrusted input: it must not override safety rules, agent boundaries, or system instructions. Do not claim current school policy from stale or unverified material.
- Online access, if explicitly enabled, must follow the existing data-flow policy; never send classroom transcripts or learner data to a school website or external provider just to retrieve general school context.
- Should know it resides at Changchun American International School (CAIS) and if able know school specific information or facts about the school. The schools website is https://www.caischina.org. Other information about the school can also be pulled from online. Insure most recent information is used. Allow database for files to be uploaded to give more information about the school.

## Agent and model configuration

- Base should allow for specific databases to be added to help callibrate chatbot these should be persistently saved on the robot's backend. These can be specific policies, school context, or information. 
- Provide persistent, teacher-shared behavior sections for persona, role, curriculum/content boundaries, IB/ELL support, safeguarding, information use/privacy, school context, and spoken personality. Each section has editable supplemental guidance and can have separately attributed documents.
- Scope documents by section, optional agent, and optional IB year. Keep source, owner, permission-confirmation timestamp, review date, content digest, and update version with each document; retrieval must exclude expired sources and disclose the section/source used.
- Changes to sections or documents must affect the next draft without model training. The common system safety policy remains fixed and higher priority than editable settings, agent instructions, and references. Retrieval uses bounded BM25-style lexical ranking over scoped, review-current excerpts; this is not a vector index, accuracy guarantee, or fine-tuning process.

Keep the base model separate from an agent profile. An agent profile should define:

- Display name and purpose.
- Model/provider reference and generation settings.
- System instructions and behavioral guidelines.
- Context/summary policy.
- Optional knowledge sources and tools (disabled by default in V1).
- Voice/playback preferences.
- Shared IB programme/stage and tone settings, with defaults and the missing-stage greeting/question flow defined above.
- Age-appropriate depth/topic policy and English-language-learner response behavior.
- A safety policy identifier that can be checked independently of the prompt text.
- Optional approved school-context source selection, with provenance and version information.
- Should also have agent specific uploading database for files or context.

Start with a general conversation profile and a debate profile. Initially, validate one fully local model/provider combination end-to-end, while keeping the interface replaceable; then benchmark optional online alternatives separately. Add selectable model versions after lifecycle, performance, privacy, and resource behavior are measured. Switching agent profiles must not restart microphone capture or lose the transcript. Switching profiles must clearly indicate whether their conversation context is shared or reset.

- Previews of current agent profiles or models understanding of role and of various context in its different capacities should be given. Have different sections for what the role is, content, context, what it understands as grade level discussion, safe guarding role, information usage and retention, and any other important inputs that are used when the chatbot would be conversing with students. All of these should be live, editable, permantely saved to the backend, and created based off of all context and specific documents regarding the specific section. Each section can have documents specifically added. Agents have access to all information and files for each section that base model uses and has. Models and agents should update and recallabrate these sections with each inputed file or change from teachers. These should automatically and instantly change chatbots behaviour. 
- All agents and models should be persitent across all teacher accounts.

### Child-safety requirements

- Define and validate the supported Early Years/PYP 1-5/MYP 1-5/DP 1-2 contexts  and school safeguarding process with educators before selecting models or writing final agent instructions. Do not claim that generic model safeguards alone make a system child-safe.
- Use age-appropriate language and content. Decline or safely redirect sexual, exploitative, violent, self-harm, illegal, discriminatory, or otherwise age-inappropriate requests; do not provide actionable harmful instructions. Send a warning immediately to the teacher's account if discussed. Avoid encouraging secrecy, dependency, or emotional exclusivity with the AI.
- Keep responses school-appropriate at all times. Apply the selected grade level to topic suitability as well as wording and depth; a more advanced stage changes educational context, not the underlying safety floor. Do not introduce mature literary themes or other sensitive material to a younger stage unless the approved curriculum and educator context explicitly call for it and the treatment is appropriate.
- The missing-stage flow must ask for the learner's programme/stage after a brief greeting, before substantive content; never infer a learner's age or stage through voice, camera, or model speculation.
- Tone, humor, school context, custom instructions, and retrieved material must not evade or weaken stage-appropriate content or safety decisions.
- Never present the system as a human, a trusted adult, or a substitute for a teacher/guardian. For disclosures involving danger, abuse, self-harm, or urgent distress, respond supportively and direct the child to a trusted adult or the classroom's established safeguarding process; do not promise confidentiality.
- Apply safety checks to both input and generated output, including transcripts, summaries, retrieved documents, and speech output. Test safety behavior for locally hosted and online models independently; a provider switch must not bypass the common application-level policy.
- Keep educator-controlled agent instructions within a safety envelope. Custom agents and knowledge sources must not disable child-safety rules or grant motion/audio recording permissions.
- Provide clear educator oversight, visible AI-generated labeling, a stop control, and reporting/escalation guidance appropriate to the deployment. Do not rely on voice identity or age estimation to decide a child's protections.
- Include privacy, consent, data-retention, and safeguarding review before real classroom use; use synthetic/consented recordings during development.
- Use researched best--practice eductional polcies (allow in the future the schools specific policies to be able to be uploaded into the settings while still using researched and proven educational practices) for safeguarding, child protection, child develpoment to maturity level standards, and language level abilities.
- Allow files to be uploaded for school specific polcies. in to specific sections about each catgory, but all use well indepth resarched inputs to configure chatbot operating perematers.

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

## Git LFS review — 2026-11-09

The inventory at review time contained **12 LFS objects totaling 5,966,053 bytes (5.69 MiB)**, all under the copied `ai-agent/research/agents/` tree in the main Uni-EDU Studio history. The research directories are not independent Git repositories in this checkout.

### Approved disposition

- Keep `livekit-plugins/livekit-plugins-silero/livekit/plugins/silero/resources/silero_vad.onnx` at **2,327,524 bytes** as a normal Git file, not Git LFS. SHA-256: `1a153a22f450e202d3ec03968cff71846284c3b70d4353b3096ce9121d34224c3`. This is the actual model loaded by the upstream Silero plugin. The plugin's `pyproject.toml` also includes the model in built wheels; retaining this copy in the research snapshot keeps the source/reference tree complete. Before using it in a product runtime, verify its model-specific terms and provenance, pin the chosen plugin/model version, and avoid needlessly duplicating model storage.
- Remove the other **11 audio files (3,638,529 bytes)** from the project tree and rewritten branch history. Keep the specific textual references below so their original purpose, source locations, and known provenance remain discoverable. None is needed by Uni-EDU voice-chat runtime.
- The LFS audio pointers occur only in unpublished commits ahead of `origin/Ai-integration`. Rewrite only the local `Ai-integration` branch, preserving the shared remote base. Do not force-push; after validation, an ordinary fast-forward push should be possible. If the branch is later found to have been shared, coordinate before pushing the rewritten commits.

### Specific references for omitted audio

The paths below are relative to `ai-agent/research/agents/`, the copied LiveKit Agents source tree (`https://github.com/livekit/agents`). The listed LFS object IDs are the content SHA-256 values from the original LFS pointers; they are references, not files that the voice service should download.

| Omitted file | Size; original LFS SHA-256 | Original purpose and source reference | Product decision |
|---|---:|---|---|
| `examples/drive_thru/bg_noise.mp3` | 352,802 B; `09c8c8f934d872b076f86ac0fe9cb429d02eb9a6cb222f7600e0c60b474bf5bc` | Ambient drive-through background track. Described in `examples/drive_thru/README.md` and passed to `BackgroundAudioPlayer` in `examples/drive_thru/agent.py`. | Demo-only; no conversational or speech-pipeline function. Omit. |
| `livekit-agents/livekit/agents/resources/city-ambience.ogg` | 393,503 B; `520910965ef316130ac7240d86fd985613769c85a22d629f3d9d316accb4623f` | Optional city ambience selected by `CITY_AMBIENCE` in `livekit-agents/livekit/agents/voice/background_audio.py`. | Optional background sound only. Omit. |
| `livekit-agents/livekit/agents/resources/crowded-room.ogg` | 318,878 B; `4a3c8c476f176b59cbcfedc212e65b4c8b0cb9b1b7555fcf09c4e7fadf8e867f` | Optional crowded-room ambience selected by `CROWDED_ROOM` in `livekit-agents/livekit/agents/voice/background_audio.py`. | Optional sound effect; it is not the diarization model or a required real-room test fixture. Omit. |
| `livekit-agents/livekit/agents/resources/forest-ambience.ogg` | 399,708 B; `6692987291acdec983db399e08d5a4dd55627bbdf1ac59b86e8988999facee5d` | Optional forest ambience selected by `FOREST_AMBIENCE` in `livekit-agents/livekit/agents/voice/background_audio.py`. | Optional background sound only. Omit. |
| `livekit-agents/livekit/agents/resources/hold_music.ogg` | 702,469 B; `cfb2a77542ac01011f41593a5fe9b919ee898343bcc66d72499b77b2640def28` | Hold music resource in the upstream LiveKit Agents voice background-audio resources. | Not part of conversation, transcription, or approved-response playback. Omit. |
| `livekit-agents/livekit/agents/resources/keyboard-typing.ogg` | 73,576 B; `56258677554c75019be52f8a16e8494ee5bccfb74c01f490b5a1befd48cbbeae` | Optional keyboard-typing sound in the upstream voice background-audio resources. The adjacent `NOTICE` attributes the sample to Anton at `https://freesound.org/s/137/` under CC BY 4.0. | Omit; preserve this textual attribution here. If ever redistributed, comply with CC BY 4.0 attribution terms. |
| `livekit-agents/livekit/agents/resources/keyboard-typing2.ogg` | 28,046 B; `1b8244f26ae315561aefdbb09387bf16388c3380d74c2e1f0008be0998169954` | Second optional keyboard-typing sound. The adjacent upstream `NOTICE` says `keyboard-typing2.opg` (upstream typo) and attributes it to Anton at `https://freesound.org/s/137/` under CC BY 4.0. | Omit; retain corrected filename and the source notice's attribution/typo in this reference. |
| `livekit-agents/livekit/agents/resources/office-ambience.ogg` | 190,410 B; `967a445f505e202d3ec03968cff71846284c3b70d4353b3096ce9121d34224c3` | Optional office ambience in the upstream voice background-audio resources. | Optional background sound only. Omit. |
| `tests/change-sophie.opus` | 48,905 B; `7a2eb5667dc35714b4cb70324d3722f89580885ee5e51be5f2c793e7893d9a24` | Audio fixture referenced by `tests/test_audio_decoder.py`; that integration test sends audio to LiveKit cloud/Deepgram and skips without valid cloud configuration. | Upstream test-only audio, not an offline product test. The speaker's identity/consent is not established by this review; do not reuse as classroom data. Omit. |
| `tests/change-sophie.wav` | 570,264 B; `16a978d4be2506cca5e25c5b7aa5b0e53451049d979684d9168c1a81beb4babd` | No code/test reference found in the copied tree; only an LFS entry in `tests/.gitattributes`. | No demonstrated purpose. Omit. |
| `tests/long.mp3` | 559,968 B; `a420326dbf4f37675bf14ae260fff776aee428ced887fc97e0936c36b96589f6` | Upstream speech fixture referenced by `tests/utils/__init__.py` as `TEST_AUDIO_FILEPATH`, paired with `long_transcript.txt`, and used by upstream STT tests (including a noted ~44.4-second speech end). | Upstream provider-test fixture, not required by our runtime. For future evaluation, make a dedicated synthetic or consented fixture and transcript with explicit data rights. Omit. |

These are references to the original copied tree and its observed source usages, not a promise that the upstream files remain available at those paths or that their audio licenses were comprehensively audited. The keyboard samples' CC BY 4.0 attribution is the only explicit sample-audio attribution found in the inspected tree. The LiveKit Agents repository has Apache-2.0 project licensing; that does not by itself establish the license/consent status of every bundled recording.

### Migration and verification record — 2026-11-09

- **Completed locally:** Converted the retained ONNX to an ordinary Git blob. Its worktree and committed blob are both 2,327,524 bytes with SHA-256 `1a153a22f450e202d3ec03968cff71846284c3b70d4353b3096ce9121d34224c3`.
- **Completed locally:** Removed the 11 audio paths from both unpublished commits. The rewrite was explicitly limited to commits reachable from `Ai-integration` but not `origin/Ai-integration`; the shared remote base remains an ancestor, and the branch is still two commits ahead. The branch does not require a force push.
- **Completed locally:** Removed the audio LFS rules from the copied LiveKit Agents attributes. The root `.gitattributes` has an explicit non-LFS exception for the retained ONNX.
- **Verified:** `git lfs ls-files Ai-integration` is empty; `git lfs status` reports no LFS objects to push for the current branch; the omitted audio paths are absent from its tree/history. No remote push was performed.
- **Backup refs:** Local pre-cleanup and filter-attempt backup refs remain for recovery and can still expose old LFS pointers to commands that inspect *all* local refs. Push only `Ai-integration` (not `--all`) unless those backups have been deliberately cleaned up. The current branch's ordinary push does not include them.
- **Not yet committed:** The attribute cleanup and this plan update are working-tree changes. Include them in the next normal commit on `Ai-integration`; then push that branch normally.

After migration, verify all of the following before pushing:

- The ONNX path remains a normal Git blob, with the SHA-256 above.
- Before a normal push, confirm `git lfs status` still lists no objects for the current branch and push `Ai-integration`, not all local refs.
- Keep any future selected offline model/version, checksum, license/provenance, and installation method documented here.

## Implementation phases

### Phase 0 — Discovery and compatibility

- Inspect the target G1's microphone/speaker APIs, audio device availability, current audio users, operating-system environment, and network arrangement.
- Record the exact hardware/firmware and available compute; measure resource headroom with existing Uni-EDU and robot services active.
- Inventory the `ai-agent/` scaffold and research references; map candidate components to concrete requirements and identify what should be reused, adapted, forked, or left as reference. Choose a first pipeline candidate only after checking license, maintenance, model requirements, child-safety limitations, and offline support.
- Record and preserve the verified LFS cleanup described above while retaining the copied research source and the regular-Git Silero model.
- Define the supported Early Years/PYP/MYP/DP contexts, stage-specific content boundaries, English-language-learner expectations, tone behavior, local/online data-flow policy, consent/retention defaults, and baseline safety tests with educators.
- Agree on the Harry Botter persona and school-appropriate voice direction. Identify licensed voice candidates by non-identifying qualities; do not pursue voice cloning or imitation of a named real person.
- Identify educator-approved Changchun American International School context sources, permissions, update owner/cadence, and local/offline packaging approach. If no approved sources are available, keep school context disabled rather than guessing.
- Verify that the chosen local component set can work without Wi-Fi; specify what optional online components add and what data they receive.
- Define initial latency, transcription-quality, diarization-quality, and resource targets from a baseline recording and hardware benchmark.

**Exit:** A documented audio I/O path, deployment arrangement, IB-stage-aware child-safety/privacy policy, ELL and persona requirements, approved school-context plan, local/online capability matrix, candidate reuse/adaptation map, and benchmark procedure; no existing robot-control mechanism changed.

### Phase 1 — Standalone desktop voice prototype

- Create the isolated service environment and a repeatable start/stop workflow.
- Begin with a browser preview linked from the existing sign-in page. Use the existing teacher authentication flow; do not auto-sign-in, prefill a shared test password, or create a separate privileged account.
- Test the development computer's microphone and speaker in the browser first. Keep any recorded sample temporary and client-side, with explicit record/stop/play/delete controls; do not send it to the server or an AI provider in this hardware-check step.
- Verify the selected speech pipeline and configured local model work with network access disabled, and expose when a component is unavailable rather than silently switching providers.
- Implement microphone capture, VAD, live transcription, session start/stop, and a basic transcript view.
- Add timestamped anonymous diarization and visibly represent uncertain/overlapping speech.
- Test from a separate computer without a physical robot or connection to Uni-EDU robot-control APIs.

**Exit:** A local conversation can be captured, transcribed, speaker-labeled, and stopped cleanly without internet access; failures are visible and do not leave audio capture running. Child-safety and data-minimization checks pass for the prototype's supported behavior.

### Phase 2 — Conversation and agent profiles

- Add structured transcript turns, bounded context, and a rolling discussion summary.
- Add the general and debate agent profiles, editable instructions, and a provider/model interface.
- Add shared programme/stage and tone settings, and ensure the settings apply consistently to general, debate, and custom agents without restarting capture.
- Implement the missing-stage greeting-and-question flow; keep stage changes explicit and apply them only to subsequent output.
- Enforce common school-appropriate safety, stage-specific language/topic/depth behavior, and ELL support regardless of the selected agent or local/online model.
- Add the Harry Botter identity/name behavior and restrained robot-perspective humor for the available tone presets.
- Add school-context retrieval only after approved sources, provenance, local availability, and update ownership are established; otherwise leave this capability disabled.
- Generate and refresh response drafts as new speech arrives, with a debounce/turn-completion policy to avoid repeatedly querying the model for every partial word.
- Keep drafts and summaries out of the verbatim transcript; show what discussion segment a draft is based on.

**Exit:** General, debate, and custom profiles can produce relevant drafts that respect the selected IB stage, topic maturity, tone, and ELL needs while preserving transcript provenance; missing-stage sessions ask before substantive answers; profile changes do not reset capture or weaken safety policy.

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

## Future direction and repository-informed next steps

This roadmap turns the repositories already collected in `ai-agent/research/` and the agreed product direction into a practical sequence. These repositories are candidates and references, not pre-approved dependencies: keep them out of the runtime until a specific capability is selected, tested, and documented. Continue to prioritize a separate environment, local processing, school appropriateness, educator control, and regression protection for existing Uni-EDU Studio and DUET behavior.

### Implementation status — 2026-11-13

- Created `ai-agent/voice-service/` as a product-owned, dependency-free Python service foundation with its own project metadata and run/test instructions.
- Added a loopback-only versioned HTTP API for health and in-memory create/start/status/stop/delete session operations. It rejects request bodies and cannot bind to a non-loopback address.
- Added lifecycle, API, and local model client tests. Verified with `cd ai-agent/voice-service && PYTHONPATH=src python -m unittest discover -s tests -v` (14 tests passed).
- Added the browser-first entry `/?try=harry-botter`, linked from the main sign-in page. It uses the existing teacher login endpoint and stores the same teacher session for return to the main app; it does not prefill credentials or bypass login.
- Added browser microphone recording and playback through the selected/default computer speaker for a maximum 30-second test. The audio is held temporarily in the page, can be deleted, and is not uploaded. The preview has preliminary stage/year and tone controls that are not persisted or connected to an agent.
- Added a product-owned, dependency-free OpenAI-compatible client that permits only loopback model URLs, bypasses proxy environment variables, checks the configured model ID, bounds responses, and never falls back to a cloud provider. The service now exposes a model-status endpoint and a bounded text-draft endpoint with a server-owned Harry Botter prompt; it does not persist chat history.
- Added teacher-authenticated backend proxy routes for model status and draft generation. Requests are forwarded only to the fixed loopback voice-service address; anonymous and student accounts are denied. No custom system prompt, audio, robot action, or uploaded context is accepted.
- Added a text-only local draft chat to the teacher preview with programme/year and tone settings, a bounded 12-message in-page history with an explicit Clear chat control, explicit model readiness, and teacher-review-only messaging. Draft requests are cancelled on sign-out. Browser audio remains separate and is not uploaded, transcribed, or connected to the model.
- Enforced a fixed missing-stage greeting/question in the service. It does not call an LLM and remains available without a configured model; substantive drafts require a selected stage and a ready local model. Prompt instructions are not a safety guarantee, and this prototype is not ready for student use.
- The model runtime and model remain unselected and uninstalled. This environment previously had no local model server available and limited memory, so substantive drafts remain unavailable until an educator/developer configures a suitable loopback runtime and installed model.
- Latest Codespace resource check: 7.8 GiB total RAM with 1.5 GiB available, 2 CPU threads, no `nvidia-smi` command/GPU reported, and no `/dev/snd` audio devices exposed. This is insufficient evidence for model or audio-device selection; do not install or download a large model here.
- Added focused Playwright coverage for the sign-in link, teacher-only preview access, mocked local audio capture/playback, and returning to the main app with the same teacher session. Verified with `npx playwright test tests/app-runtime.spec.js --grep 'sign-in page links|Harry Botter preview'` (2 tests passed; audio devices are mocked, so this is not a physical-device test).
- Added focused service/provider tests for local model status and completion, unavailable/malformed responses, rejected non-loopback URLs, explicit unconfigured-model errors, and server-owned prompts (14 passed). The focused backend test for teacher-only access, fixed loopback forwarding, strict request validation, and explicit unavailable-model errors passed.
- Updated the server-owned prompt to identify Harry Botter as used at CAIS while explicitly stating that no current school knowledge base is connected. A focused regression test now covers the school identity, missing-stage question, and knowledge-source limitation.
- Enforced the missing-stage greeting as a fixed server-owned response rather than relying on model compliance. It does not call the model, is available when no model is configured, and the teacher preview labels it as a stage prompt rather than an LLM draft. A selected stage remains required before local-model drafts are enabled.
- Added API/client tests for the deterministic missing-stage path. All 14 voice-service tests pass. The new missing-stage Playwright test passed once. The existing selected-stage chat test exposed and led to correction of a stale assertion about the documented 12-message history cap; subsequent browser reruns could not reliably reach the preview because the Vite test server became unavailable. Browser regression verification remains incomplete.
- Fixed preview scrolling by overriding the full-screen editor's global overflow lock only while Harry Botter preview is mounted. A Playwright Chromium check at 1280x720 scrolled from the login view to the audio setup section (scroll position 667px, page height 1,387px). This verifies page layout only, not physical audio devices. No physical microphone or speaker test has been done.
- Made the preview's current capability explicit near the top: browser recording/playback is only a local device check, with no transcription or model-connected voice chat; substantive replies also need a configured local LLM. For microphone denial, the preview now explains that webpages cannot open or change browser permissions, provides a user-clicked link to the same preview in a full browser tab, and gives address-bar permission-setting guidance. Targeted ESLint and test syntax checks passed, and Chromium verified the recovery UI and top-level-tab link with a mocked browser denial; physical device access is still unverified.
- Changed frontend files pass targeted ESLint. An earlier production build succeeded with the preview-only changes; a fresh build after adding chat was terminated by the environment (exit 143) after module transformation, without a compiler diagnostic, so the latest production build remains unverified. Existing build warnings include missing `guest-login-print.css`, externalized `node:fs`, and the large bundle.
- This does **not** complete Phase 0 or Phase 1: repository/model selection, live transcription, diarization, LLM/TTS in the voice pipeline, saved agent or school settings, and robot audio/integration remain unimplemented. Browser device testing is not a physical G1 acceptance test.
- No local knowledge pack has been approved or connected. CAIS identity is context only; the assistant must not claim current school facts or policy.
- Next: use the new-tab link or copy the private HTTPS preview URL into a full browser, set the site microphone permission to Allow using the browser's address-bar site controls, check OS microphone privacy settings, reload, and retry the actual microphone/speaker test. Candidate screening below is preliminary only; model terms, upstream revisions, current maintenance, target compatibility, and on-device benchmarks remain unresolved before any dependency selection.

### Implementation update — 2026-11-16

- Added switchable **Typing chat** and **Microphone test** modes to the teacher preview. Text chat is the default for response-quality testing without speaking; changing modes keeps the current in-page chat intact. Leaving microphone mode while recording stops the recording.
- Kept microphone mode explicitly limited to local device recording/playback. It does not transcribe speech or send audio to the model; live voice conversation remains unimplemented.
- Added browser regression coverage for mode switching, chat retention, accessing the microphone test only after selecting that mode, and stopping an active recording when switching back to text.
- Verified with `npx playwright test tests/app-runtime.spec.js --grep 'Harry Botter preview uses teacher login|Harry Botter preview explains blocked microphone permission|Harry Botter preview sends text only|Harry Botter asks for a stage'` (4 passed), `npx eslint src/components/HarryBotterTry.jsx tests/app-runtime.spec.js`, and `npm run build` (passed). The build still reports the pre-existing missing `guest-login-print.css`, browser externalization of `node:fs`, and large-bundle warnings.

### Teacher configuration and draft review update — 2026-11-16

- Added two persistent built-in profiles (general and debate) plus teacher-only shared create/update/delete for custom profiles. The common system prompt remains service-owned; per-profile instructions and generation settings are bounded and cannot replace that shared policy. All agents currently use the same local model provider/model.
- Added a teacher-only, backend-database knowledge library shared across teacher accounts. It accepts UTF-8 `.txt`/`.md` content up to 100 KB with required source, owner, permission confirmation, stage scope, agent scope, and review date; it records a SHA-256 digest and supports retrieval, editing/replacement, and deletion. The shared library is limited to 100 documents and 10 MB total. Student accounts cannot access it. Only relevant documents matching the selected agent/stage and not past their review date contribute bounded excerpts to a draft. The response returns source metadata for display. Retrieval is lexical ranking, not a vector index or a verification of source accuracy.
- Added teacher UI for profile editing and creation, local reference upload/edit/deletion, and stage/tone selection. Teachers can inspect and revise reference content and provenance; a replaced document's digest is recomputed, and changes apply to subsequent drafts. Agent and knowledge changes are stored in the shared local application database; chat history remains temporary in-page state.
- Added edit, regenerate, and dismiss actions for text drafts. Regeneration uses the originating user turn and earlier chat context; drafts remain clearly separate from user messages and are never automatically spoken. No licensed TTS or voice playback adapter is selected.
- Strengthened prompt construction to keep common school-safety/stage/identity rules above teacher-authored instructions and to label uploaded excerpts as untrusted reference data. This prompt policy is not a technical child-safety guarantee and the preview remains teacher-only.
- Focused backend and service tests cover shared profile persistence, teacher authorization, upload validation, stage/agent/staleness filtering, source provenance, bounded agent settings, and prompt treatment of reference excerpts. Browser tests cover profile editing, scoped file management, draft editing/regeneration/dismissal, and the existing text/microphone mode switch.
- Added focused coverage for authorized knowledge detail retrieval and update, digest refresh, and the browser edit/replacement path. Latest verification: all 3 focused backend tests passed; all 18 voice-service tests passed; all 7 Harry Botter Playwright tests passed; targeted ESLint passed; `npm run build` succeeded. The build still reports the pre-existing missing `guest-login-print.css`, browser externalization of `node:fs`, and large-bundle warnings.
- **Still blocked and not represented as complete:** no local LLM runtime/model is installed or configured; the host reports no `/dev/snd` devices, and no local VAD/STT/diarization/TTS runtime is installed. Microphone tests use browser mocks in automated tests; no live transcription or speaker labels are available. No educator has approved safeguarding criteria, curriculum boundaries, school materials, or voice candidates. Do not use this preview with students.
- Continue to exclude G1 connection and all motion capability. Those are not required by this browser preview and remain outside the implementation completed here.

### Local voice-turn implementation update — 2026-11-16

- Used `ai-agent/research/local-voice-assistant/` as an architecture/setup reference for an Ollama + Whisper + Kokoro pipeline. Its README assumes an 8 GB NVIDIA GPU for Qwen3 8B, Whisper small/CUDA, and Kokoro; that is not a suitable default for this CPU-only Codespace. The reference checkout has no license file, so no reference source code was copied.
- Added product-owned optional audio adapters and loopback APIs: bounded temporary browser audio is transcribed with `faster-whisper` (`Systran/faster-whisper-tiny.en`, CPU INT8 by default), text drafts use the existing Ollama-compatible local LLM client, and explicitly approved drafts can be synthesized to WAV with Kokoro (`af_heart`, a generic voice). The current lightweight LLM setup guide uses `qwen3:0.6b` (about 523 MB, Apache-2.0 as shown by Ollama). Kokoro-82M's model card reports Apache-2.0 weights. Review all package/model/voice terms before school deployment; no celebrity voice imitation is implemented.
- Added a teacher-authenticated backend proxy for speech status, transcription, and synthesis. Raw audio is limited to 8 MB, processed from a temporary file, and not persisted. Transcript text is returned for teacher review before it is sent to draft generation. Generated speech is never auto-played; the teacher must prepare it and press Play.
- Added a teacher-controlled **Stop spoken reply** action, abortable speech generation, playback shutdown when leaving the text mode or signing out, and object-URL cleanup when drafts are replaced, edited, dismissed, or chat is cleared. This improves explicit cancellation but does not implement microphone-triggered barge-in or cancel inference already running inside the local speech service.
- Added `pip install -e ".[audio]"`, `python -m harry_botter_voice.setup_models`, local cache setup under the Git-ignored `ai-agent/voice-service/models/`, and an offline runtime configuration to the service README. Ollama and Hugging Face model downloads happen during explicit setup; Hugging Face offline mode is the runtime default. The models are not bundled in Git.
- Codespaces caveat: browser microphone audio traverses the authenticated Codespaces connection to the remote workspace. For processing to stay on the user's own computer, the app/backend/voice service and model caches must be run from a local checkout.
- Verification: 19 voice-service tests, 4 focused backend tests, all 7 Harry Botter Playwright tests, targeted ESLint, production build, and a service wheel build passed. Automated speech tests use a fake speech runtime; no audio model weights were installed or executed here.
- This implements a **turn-based voice test**, not the full live pipeline: this Codespace has no `/dev/snd`, no local Ollama binary, 2 CPU threads, and about 4.2 GiB available memory at check time. Real microphone/speaker and actual model quality/performance remain unverified. Continuous VAD, streaming transcription, speaker diarization, barge-in, and live speech remain open acceptance work. Do not claim physical voice acceptance or enable student use based on mocked tests.
- Strengthened the shared model prompt with differentiated Early Years/PYP/MYP/DP depth guidance, age-appropriate topic boundaries, clearer ELL instructions, and explicit handling for unsafe requests and urgent-distress disclosures. Teacher-authored instructions and retrieved references remain subordinate to this policy. This is still model guidance—not a technical safety guarantee—and the preview has no safeguarding-alert workflow; educator review and student use remain blocked.

### Streaming voice implementation update

- Added an explicitly started **Voice conversation** mode to the teacher preview while retaining typing chat and the separate microphone/speaker test. The browser AudioWorklet downmixes and resamples microphone audio to 16 kHz mono signed PCM and sends fixed 20 ms frames through the authenticated backend.
- Added a teacher-authenticated backend WebSocket route that proxies only to `ws://127.0.0.1:8766/api/v1/audio-stream`. Student and unauthenticated sessions are denied; malformed frame sizes are rejected; service-unavailable errors are visible. The backend WebSockets constraint now allows installed major versions 15 through 17 while the voice service pins 15.0.1.
- Selected `webrtcvad-wheels==2.0.14.post1` (MIT according to its PyPI metadata) for in-memory voice activity segmentation rather than bundling the research Silero model. The isolated audio extra now explicitly includes NumPy for PCM-to-Whisper sample conversion. The local service starts its stream server only when the required local dependencies are available.
- The service expects 16 kHz mono PCM, exactly 640 bytes per frame, and bounds an utterance to 20 seconds. VAD uses a 3-of-5-frame onset window and 15 silence frames to end a turn. It emits ordered speech-start, final-transcript, speech-end, error, and stopped events; no partial token transcript is claimed. Audio is cleared after each transcription and is not persisted.
- Each final transcript is added to the temporary in-page conversation and automatically sent for local draft generation. Drafts remain editable from typing mode; Kokoro speech is still created only on request and requires an explicit Play action. Stop shuts down browser microphone tracks, the audio worklet/context, and the stream; the service finalizes any current utterance before stopping.
- Added teacher-selectable slower/normal/faster Kokoro playback pace (0.85/1.0/1.15), with the local API enforcing a 0.75–1.25 range. Voice-generated drafts show browser-observed seconds from transcript receipt to draft response so teachers can assess turnaround; this is not a model-only latency benchmark.
- When a teacher is explicitly playing a generated browser reply during an active voice session, the next VAD speech-onset event stops that playback. There is still no automatic speech, and device-specific echo/false-onset behavior has not been tested.
- Verification covers PCM resampling/frame size, transcript sample conversion, VAD segmentation/order/cleanup, WebSocket start/stop and invalid formats, authenticated backend proxy behavior, and browser-mode integration with mocked microphone, WebSocket, local LLM, and TTS responses. The browser test also confirms that VAD speech onset stops explicitly playing TTS. Latest focused checks: 27 voice-service tests, 3 backend proxy tests, targeted Harry Botter Playwright tests, targeted ESLint, and production build passed. The full browser selection intermittently lost its Vite server after a test timeout; affected cases passed when run individually or in a smaller selection. Build warnings remain for the existing missing `guest-login-print.css`, browser externalization of `node:fs`, stale Browserslist data, and large bundle.
- Installed local inference models in this Codespace: Ollama 0.40.16 with Qwen3 0.6B, faster-whisper `tiny.en`, and Kokoro `af_heart`. Verified a real local Qwen completion, Kokoro WAV synthesis at a selected pace, and a synthetic speech turn through WebRTC VAD and Whisper; one transcript had a minor first-word recognition error. This verifies inference plumbing only, not response/speech quality or human-audio accuracy.
- **Still unimplemented or externally gated:** partial transcription, speaker diarization/anonymous speaker clustering, confidence/overlap handling, persistent session/transcript management, recording confirmed robot speech, physical desktop audio acceptance, educator safeguarding/curriculum approval, G1 microphone capture, and physical G1 speaker acceptance. Browser VAD-triggered playback stop is implemented, but hardware behavior is unverified. The current Codespace exposes no audio device; do not treat synthetic audio or mocked browser devices as a microphone test or use the preview with students.

### Optional G1 speaker preview addendum — 2026-11-16

- The teacher-only Harry Botter preview may explicitly send a draft of up to the general 12,000-character draft limit to the connected G1 audio client using the existing `AudioClient.TtsMaker` path. Browser/local output remains the default; selecting G1 does not speak until the teacher clicks **Speak this draft on G1**. The backend checks teacher authorization and live audio-client status and does not add a motion command. The prior 120-character G1 preview/`robot.say` UI cap was removed so full classroom conversations can be tested; hardware SDK text limits remain unverified and will be reported if the robot rejects a payload.
- This is speaker output only: it adds no microphone capture, paid/hosted speech service, or new TTS model. SDK acceptance does not prove audible output. The target robot, TTS voice IDs, firmware behavior, and speaker remain unverified pending supervised G1 testing.

### Browser-first integration and startup update

- Connected the teacher preview end to end through teacher-authenticated backend routes for model status, draft generation, transcription, browser TTS, shared agent/knowledge configuration, and an authenticated WebSocket proxy. The voice service remains loopback-only; no motion command is exposed to it.
- The LLM route is provider-neutral OpenAI-compatible: a local loopback endpoint is the default (Ollama is the default runtime, not a requirement); an explicitly configured private numeric-IP model endpoint is tried first and falls back to the configured local model. Model readiness/draft UI reports the selected route and local fallback. No LAN discovery, cloud provider, API key, or implicit external route is used. Network model-list checks are bounded to five seconds.
- `npm start` now starts the configured model runtime when needed, the isolated voice service, and backend together. `backend/install_g1_service.sh` generates a user systemd unit that invokes this manager with the selected Unitree SDK Python environment; it reuses the already-built frontend, loads optional `.env.harry-botter.local` route settings, and waits for startup readiness. The first launch may download Python voice dependencies and local model weights. A configured custom loopback model endpoint skips Ollama setup; if the default Ollama runtime is missing, the app still launches and reports model unavailability instead of failing the whole app.
- Follow-up: `npm start` now detects and reuses an existing healthy Uni-EDU backend on the configured port (5179 by default) instead of failing on `EADDRINUSE`; it also reuses an existing healthy voice service, starts only missing services, and stays running to supervise services it launches. It never switches the preview to a different port just because the app is already running.
- `npm run dev` now delegates to the same complete application launcher and starts Vite, the backend, and the isolated voice service together. `npm run dev:frontend` is retained only as an explicit frontend-only command for an existing managed stack. The G1 systemd unit continues to launch `npm start`-equivalent lifecycle code, so browser and G1 hosted use do not require separate backend or voice commands.
- A managed service exiting or restarting no longer shuts down the whole application stack. Ollama, the backend, the voice service, and Vite development server are supervised and restarted after a two-second delay; explicit Ctrl+C or startup-fatal errors remain the only normal launcher-wide stop paths.
- The launcher now also runs a periodic loopback health monitor for Ollama, the backend, and the voice service. An unhealthy process is terminated and restarted with backoff, while restart state remains inside the running `npm start` process rather than requiring the operator to relaunch it.
- Saved agents are now applied explicitly to the active conversation by selecting them in the Agent for this chat control. The UI persists the agent, stage, and tone immediately through the session-settings endpoint, so switching agents affects subsequent text and live-microphone drafts without requiring another message and remains associated when the conversation is reopened.
- All saved agents support both single-person and group conversations. The conversation control persists a `single` or `group` mode per saved conversation. Group mode provides adaptive session-local voice matching or explicit `Speaker 1` through `Speaker 6` teacher-selected labels. Adaptive matching compares each utterance's local spectral embedding against profiles learned during only the active conversation, adds a new provisional label for a dissimilar voice, and reuses a matching label for similar subsequent utterances. It does not infer names, faces, identity, age, or cross-session enrollment. The match is uncertainty-aware and should be labeled as provisional. Automatic speaker labels are kept separate from chat drafts and retained only with the conversation's transcript metadata; the operator can switch to teacher-selected labels at any time.
- The G1 systemd unit uses `Restart=always` and the installer waits for both the hosted backend on port 5179 and the loopback voice health endpoint on port 8765 before reporting success. This prevents a browser-ready backend from being presented as a complete AI deployment while voice startup is still incomplete or has failed.
- Voice mode captures browser microphone PCM, transcribes locally with VAD/Whisper, creates reviewable drafts using the configured loopback/private-network LLM route, and only synthesizes/plays browser speech after teacher action. G1 speaker output remains a separate explicit teacher action using `TtsMaker`. Repository inspection found no G1 microphone capture path in the current SDK integration; target-image microphone APIs are not verified.
- The environment guide now calls out that remote browser microphone capture needs a trusted HTTPS origin; the installed HTTP service supports text chat but does not provision classroom-device TLS certificates.
- Verification in this Codespace: 31 voice-service unit tests, 5 Harry Botter backend API tests (including unauthenticated/student WebSocket rejection), 2 focused G1 TTS helper tests, targeted ESLint, production frontend build, Node syntax, installer Bash syntax, and whitespace checks passed. The added model-route Playwright test could not launch because Chromium's `libatk-1.0.so.0` system library is absent. Two unrelated full `test_g1_robot.py` cases still fail around arm-action expectations; no motion behavior was changed here. The installer, physical microphone, and G1 speaker have not been tested on the target host.
- The current Codespace runner has no Ollama executable, isolated voice virtualenv, cached speech weights, or `/dev/snd`; a full `npm start`/systemd startup smoke test was not attempted because its first run would install dependencies and download model weights. Prior model-inference results recorded above are historical and do not establish that caches are present in this runner now.
- These results do not constitute physical acceptance or educator safeguarding approval. The teacher preview remains non-student-facing until supervised G1 audio tests and the independent educational, privacy, licensing, and safeguarding gates are complete.

### Research-folder audit and selected components

The [research-folder audit](./ai-voice-research-audit.md) inventories all 47
top-level research folders and records a disposition for each. `SOURCES.tsv`
contains upstream commit IDs for 45; Crawl4AI and SearXNG still lack recorded
upstream snapshot commits. The optional web-research runtime now uses pinned
Crawl4AI 0.9.5 and SearXNG 2026.11.21 Docker image digests; those image pins
do not establish the exact commits of the separately checked-in research
snapshots. The inventory is not a complete upstream source audit, and
product-level tests are not upstream acceptance tests. Project software
licenses do not establish the licenses or suitability of bundled model
weights, voices, or other assets. Re-check exact source, dependency, model,
voice, and nested-license notices at deployment.

| Candidate | Checked-in project license and relevant evidence | Current disposition |
|---|---|---|
| Product-owned WebRTC VAD | `webrtcvad-wheels==2.0.14.post1`; PyPI metadata identifies MIT and Python >=3.10. Fixed 10/20/30 ms PCM frames; no voice embeddings. | Selected for bounded in-memory VAD segmentation. Add dependency/source notices to deployment records and re-check provenance at release. |
| faster-whisper | MIT project code; model downloads have separate terms. The product-owned adapter already supports CPU INT8 and explicit model-cache setup. | Keep as the local STT adapter; `tiny.en` is the documented default and its weights were downloaded and exercised through synthetic VAD-bounded audio in this Codespace. Human audio quality is not established. |
| Kokoro | Apache-2.0 code/model reference; exact voice/model terms remain a separate deployment gate. | Keep the product-owned adapter and curated generic voice presets. Identifiable-person imitation is excluded. |
| Pipecat, Hugging Face Speech-to-Speech, LiveKit Agents | Useful pipeline/event/cancellation architecture; include hosted paths or additional model/infrastructure terms. | Architecture reference only; no framework dependency, hosted provider, or auto-play behavior adopted. |
| local-voice-assistant | No top-level license found in the checked-in snapshot; documents an Ollama/Whisper/Kokoro setup with an 8 GB GPU. | Setup/architecture reference only; no code copied or redistributed. |
| Silero VAD and diarization candidates | Silero model terms/provenance are unclear; pyannote and SpeechBrain models have separate license, download, privacy, and resource gates. | Do not bundle Silero weights. No diarization model or speaker clustering selected. |
| LocalAI and other local LLM runtimes | LocalAI is MIT with multiple optional backends; the project already uses a loopback OpenAI-compatible interface and documents Ollama. Model terms and hardware fit are separate. | LocalAI remains a possible runtime alternative; no dependency/model bake-off or actual model inference was performed here. |

### Remaining acceptance sequence

1. **Repeat local inference and accept audio on the intended desktop.** This Codespace currently has Ollama and Qwen3 0.6B; the native local route, measured warm/cold draft timing, and a real local Kokoro WAV synthesis are recorded above. A speech test running outside the managed environment did not see the app-specific Hugging Face cache. Follow the service README's explicit setup steps on the target machine; verify model/voice provenance, offline behavior, latency, memory, CPU/GPU use, and real microphone/speaker behavior. Synthetic turns are not a quality benchmark.
2. **Complete consented desktop audio acceptance.** Test actual microphone selection, transcript accuracy/noise behavior, playback routing, start/stop, service loss, and cleanup. Automated tests mock browser devices and model adapters.
3. **Resolve independent review gates.** Educators must approve safeguarding criteria, curriculum/stage boundaries, CAIS sources, consent and escalation behavior, and voice options before any student use. Prompt tests do not satisfy this gate.
4. **Revisit diarization only after a separately licensed local model and privacy/resource review.** Until then, speaker is explicitly `null`, no identity is inferred, and speaker labels are unavailable.
5. **On the target G1, supervise explicit speaker output and investigate available microphone-capture interfaces.** The current repository supports G1 TTS only; do not claim microphone access until the actual image/device path is identified and tested. Keep motion capability out of the voice service, and keep student deployment blocked until physical, privacy, licensing, and educator safeguarding gates pass.

The [research audit](./ai-voice-research-audit.md) is a checked-in snapshot
inventory, not an upstream release audit. No research repository is a runtime
dependency.

### Browser completion hardening update

- Restored valid teacher sessions from the existing browser session storage on page reload; malformed or non-teacher session data is discarded. Chat/transcript contents remain ephemeral and are not added to browser or backend persistence.
- Voice-mode draft generation now reads the latest selected stage, tone, and agent at the time each transcript is processed. Those controls can change during an active session, and each generated draft records its settings in the temporary UI history; microphone selection still requires a stop/restart.
- Added a Clear conversation control in voice mode as well as typing chat. It suppresses late transcript events, clears queued turns, aborts the current draft and speech requests, stops playback and active capture, and removes in-memory turns/drafts.
- Fixed the model-route control label and routed prepared voice-mode browser speech to the selected browser output device when supported.
- At this iteration the preview only had a warning and no alert workflow; the later continuation below adds limited advisory phrase-pattern alerts, not comprehensive detection or a staffed safeguarding process.
- Verification: targeted ESLint, `git diff --check`, and `npm run build` passed. The focused Playwright tests for model routing and restored teacher sessions could not launch because this runner lacks Chromium's `libatk-1.0.so.0`. Build retains existing warnings for the missing `guest-login-print.css`, browser externalization of `node:fs`, stale Browserslist data, and the large bundle.
- Remaining at that point: persistent conversations and alert workflow. Later continuation below adds teacher-only sessions and advisory alerts with manual deletion; policy approval, privacy/security review, diarization, physical desktop/G1 audio acceptance, G1 microphone support, setup-command/systemd smoke testing, model availability/performance on the target, and student-readiness review remain external gates.

### Persistent behavior sections, knowledge categories, and tone presets — 2026-11-19

- Added eight shared, backend-database behavior sections: persona, role, curriculum/content boundaries, IB/ELL support, safeguarding, information use/privacy, school context, and tone/spoken personality. Teacher edits are loaded into every subsequent draft; common system safety rules remain fixed and higher priority. School-context and safeguarding edits require an explicit teacher approval confirmation.
- Added section categories to the existing attributed knowledge library. Documents can be shared across all agents or scoped to an agent and IB year, and to a behavior section. Source, owner, permission-confirmation timestamp, review date, content digest, creation/update timestamps, and a monotonically increasing current version are retained. The API migrates existing rows to `general`, version 1, and carries forward the existing update timestamp for documents that were uploaded through the previously confirmation-gated API. Historical document bodies are not archived.
- Added a teacher UI to edit/save shared section guidance and categorize uploaded references. Changes apply on the next draft without model training or a model-weight update. The existing caps remain: `.txt`/`.md`, 100 KB per document, 100 documents and 10 MB total, up to three retrieved excerpts per draft.
- Expanded teacher-preview tone choices to Formal, Lightly humorous, Warm and encouraging, Curious/Socratic, and Concise. Each has distinct server-owned prompt guidance and is validated by both backend and isolated voice-service APIs. The added tones are for educator evaluation only, not student approval.
- Added regression coverage for old-schema migration, shared section persistence across teacher accounts, approval-gated school guidance, section-scoped retrieval and provenance, and tone prompt/API behavior.
- Limitations: retrieval remains bounded keyword ranking and may omit a relevant document when more than three match; it is not semantic search or a fact-verification guarantee. Editable section content and uploaded documents are supplemental prompt context, not fine-tuning. The later continuation adds phrase-pattern alert signals, but not comprehensive safeguarding detection or a dependable school alert workflow.
- Current verification: backend Harry Botter unittest suite (7 passed), voice-service suite (33 passed), targeted ESLint for the changed component and browser test, production build, `node --check` for the browser test, and `git diff --check` passed. The repository-wide `npm run lint` is not clean (3,637 errors and 524 warnings across the full workspace, including vendored code); the changed UI/test files pass targeted ESLint. The focused Playwright test could not start because Chromium requires the unavailable `libatk-1.0.so.0` library.

### Browser-first teacher workflow continuation

- Added persistent, teacher-owner-only conversation text in the local application SQLite database. Teachers can create, restore, clear, and delete conversations; deleting a conversation also deletes its related advisory alerts. Each conversation is limited to 500 messages and 1 MB of text. The complete transcript is retained, while only the most recent 12 turns are supplied to the model. Raw audio remains unretained. Storage is not encrypted at rest; this remains a teacher preview and must not be used with students pending privacy review.
- Added limited phrase-pattern alerts for possible self-harm, abuse, and immediate danger disclosures. They are advisory, visible only to the owning teacher, and can be acknowledged; no email or external notification is sent. They may miss disclosures or flag ordinary discussion and do not replace a staffed school safeguarding workflow.
- Added a teacher activity planner that drafts an editable plan from the selected IB stage, agent, duration, objective, and material constraints in the current saved conversation. It does not publish or change shared agent settings.
- Added an authenticated policy/source review path. A teacher selects up to three permission-confirmed references currently in scope for the chosen behavior section, stage, and agent; expired references are rejected, and only the first 2,500 characters of each reference are sent to the configured local/private-network model. The response is a separate proposal with source notes, potential conflicts, and educator questions. It is not saved automatically: the teacher must copy it into the editor and explicitly save; approval-gated sections still require their existing confirmation. Model-generated citations and comparisons require human verification.
- Verification in this continuation: policy-review backend tests (2 passed); backend API suite excluding the WebSocket-auth test (10 passed); focused voice-service API/model tests (28 passed, plus 12 subtests); voice-service suite excluding streaming tests (30 passed, 1 skipped, plus 12 subtests). Python syntax checks passed for changed backend/service modules and tests; targeted ESLint and `node --check` passed; `npm run build` passed with pre-existing missing CSS, Node module externalization, stale Browserslist, and bundle-size warnings. The backend WebSocket-auth test's two subcases and the voice streaming test cannot collect/run because the current Python environment is missing the already-declared `websockets` dependency. The focused Playwright browser cases cannot launch because Chromium lacks `libatk-1.0.so.0`.
- Outstanding gates remain: verify installer/systemd startup using the requested G1 command; test model latency and quality on the target machine; validate physical G1 microphone and speaker paths; obtain educator approval for CAIS policy, age/stage boundaries, and safeguarding workflow; complete privacy/security and voice-license review; and do not enable student-facing use before those gates.

### Browser Kokoro sample preview update

- Implemented the safe portion of the requested voice configuration scope: generic Kokoro presets (`af_heart`, `af_bella`, `af_nicole`, `am_michael`, `bm_fable`, and `bm_george`) can be switched in the teacher preview. A candidate is not applied to future replies until its sample is generated and the teacher presses Play, then **Use auditioned voice**.
- The `bm_` presets use Kokoro's general British English pipeline; they do not establish a Fulham-specific accent or a child's age. Celebrity imitation and voice cloning from public recordings or repositories are not part of this implementation. Clarity, warmth, pace, and energy still require listening-based evaluation; pace is adjustable, while no independent clarity/warmth/energy controls are claimed.
- Browser Kokoro playback remains separate from G1's SDK `TtsMaker` path. The setup command warms the curated presets for later offline use; `HARRY_BOTTER_TTS_VOICE` defaults to `af_heart`.
- Verification: voice API/synthesis tests passed (14 passed, 1 skipped, 3 subtests); the authenticated backend speech-proxy test passed; Python syntax checks, Pylance call-site compatibility, component JSX parsing, browser-spec syntax, and whitespace checks passed. Targeted ESLint, the focused Playwright test, and production build were attempted but their processes were terminated with exit code 143 in this runner, so they are not counted as passes. No sound was auditioned on an audio device; voice quality, rights review, desktop output, and G1 output remain acceptance gates.

### Optional Qwen3 VoiceDesign update

- Added an opt-in Qwen3-TTS 1.7B VoiceDesign adapter and teacher-preview preset. It generates directly from a fictional youthful South London/Fulham-area text description; it does not use a reference audio sample, clone a person, or claim a verified age/accent. A candidate still must be generated and played before it can be applied to browser replies.
- The Qwen extra and model download are excluded from normal application startup. `HARRY_BOTTER_ENABLE_QWEN_VOICE_DESIGN=1` exposes the preset only when the optional package and CUDA/MPS device are available; the explicit `setup_voice_design` command downloads/loads the model before offline operation. Kokoro remains the small default and the G1 SDK speaker path is unchanged.
- The Qwen3-TTS code repository identifies Apache-2.0 code, but model-weight terms require separate review. Voice Clone Studio's README recommends an 8 GB+ CUDA GPU; no target hardware or audio audition has verified quality, latency, or resource use. Review those terms and educator suitability before school deployment.
- Focused mocked tests verify optional-preset gating, API routing, generated WAV sample-rate handling, and audition/apply UI flow. Actual voice synthesis remains an external hardware acceptance gate.

### Structured session data, applied voice, and local latency update — 2026-11-19

- Added schema migration 2, recorded in `harry_botter_schema_migrations`, with `harry_botter_session_settings`, `harry_botter_transcript_turns`, `harry_botter_session_summaries`, `harry_botter_response_drafts`, and `harry_botter_playback_events`. Existing session JSON messages are backfilled into distinct typed/transcribed turns and generated drafts; migration uses `INSERT OR IGNORE` to preserve existing records. Session deletion and clear operations remove the dependent structured records. The summary table is a storage contract only: rolling summary generation is not implemented.
- Session settings explicitly store agent, IB level, tone, language, and context policy. Agent records now carry shared teacher-selected TTS voice and speed. New knowledge uploads require an intended-use description and pass it with the attributed excerpt to the model; pre-existing knowledge is retained with an empty intended-use value until edited.
- Fixed the applied-voice path: changing voice or pace persists the selected agent's setting, invalidates prepared audio, and sends that setting to synthesis for later drafts. Completed browser playback records the draft/text snapshot, selected voice and speed, output path, and duration. Auditioning alone is not recorded as playback.
- The default loopback Ollama endpoint now uses its native `/api/chat` interface, explicitly disables Qwen thinking, limits generation by the existing token setting, and requests a ten-minute model keep-alive. Explicit custom OpenAI-compatible endpoints retain the existing `/chat/completions` path; model warm-up is restricted to the local route even if an optional private-network model is configured. `npm start` checks model readiness, warms the local LLM and selected default speech voice before launching the backend, and logs warm-up failures without blocking startup. It detects an already-running Ollama API even when the CLI is absent and reuses a valid backend virtualenv, falling back to `virtualenv` when Python's `venv` module cannot seed pip. The shared prompt now prefers direct, concise answers without imposing a short-answer rule on teacher activity plans.
- Model readiness checks now have an 8-second backend deadline and a 10-second browser timeout, so an unavailable or stalled local service reports an actionable error instead of leaving the UI in a perpetual checking state.
- Prior local timing measured 6.53 seconds for the first Qwen3 0.6B native request (including 4.73 seconds of model load) and 1.24 seconds warm. The OpenAI-compatible route ignored `think: false` and spent a 128-token budget reasoning without returning visible content; the new native path specifically addresses that observed issue. These figures are a local smoke measurement, not a classroom latency or response-quality acceptance benchmark.
- Live managed-stack smoke results: the first draft request after startup took 8.60 seconds; two subsequent identical requests took 0.96 and 0.91 seconds. Kokoro generated an `af_bella` WAV at speed 1.15 in 21.60 seconds on first use and 1.78 seconds on the next sample. These measurements prompted startup warm-up for both the LLM and the configured default TTS voice; they are single-host observations, not guaranteed performance or audible-device acceptance.
- The final managed startup logged successful LLM and default-voice warm-ups and served the backend. A subsequent local draft took 2.80 seconds; an `af_bella` WAV at speed 1.15 took 4.55 seconds. The returned WAV was inspected as valid `audio/wav` data, but was not auditioned on a physical speaker.
- Verification for this update: the local model tests passed (19), voice API tests passed (17), speech warm-up unit test passed (1), the applied-voice browser test passed (1), the backend API suite passed (15), and `npm run build` passed with pre-existing warnings. The full voice-service suite run before the last warm-up tests ran 49 tests; one Kokoro integration test could not load weights using the test process's default Hugging Face cache under offline mode, while the other 48 passed. The managed stack's configured cache did load Kokoro in a live synthesis request. Physical playback and microphone paths still require device acceptance.
- Not completed by this change: generated rolling summaries, speaker diarization, per-agent provider/model selection, a robust cold-start latency target, real audio-device verification, and educator/privacy/safeguarding approvals. The preview remains teacher-only and is not approved for student use.

### Device-microphone conversation with G1 speaker output — 2026-11-20

- Voice conversation captures from the browser-selected device microphone. Its reply destination can now be selected directly in voice mode; choosing G1 routes only after the teacher explicitly presses **Speak this draft on G1**. The browser/local-speaker option remains available, and no reply is spoken automatically.
- G1 speech uses the existing teacher-authenticated `/api/harry-botter/g1-speak` audio endpoint and `AudioClient.TtsMaker` adapter instead of submitting a program through `/api/run`. This keeps voice playback on the G1 speaker without routing through the robot-program interpreter or adding microphone capture on the robot.
- The G1 speaker ID remains selectable. The browser TTS voice setting applies only to browser playback; G1 uses the robot's speaker voice. G1 audio must be connected in Uni-EDU Studio before the send action is enabled.
- Verification: ESLint, the production frontend build, and the authenticated G1 TTS API test passed. The focused browser test covers voice-mode microphone selection, G1 destination/speaker selection, and the G1 speech request shape, but could not launch because the Playwright Chromium binary is not installed. No physical microphone or G1 speaker was available for hardware acceptance.
- G1 host installation remains blocked in this Codespace: the requested `G1_SDK_ENV_DIR="$HOME/venvs/g1-sdk" INSTALL_G1_LIDAR=1 bash backend/install_g1_service.sh` command stopped at the prerequisite check because neither the requested Unitree SDK environment nor the installer's fallback exists. The installer and LiDAR setup made no changes. Run it on the target G1 host after provisioning the SDK environment and required DDS/deployment prerequisites.

### Database-integrated draft context update — 2026-11-19

- Replaced purely excerpt-at-the-time prompting with a persistent document-chunk index in SQLite. Upload and update operations now rebuild the document's indexed chunks; document, custom-agent, and knowledge deletion remove associated chunks.
- Draft retrieval now ranks attributed chunks across the permission-confirmed, stage-scoped, agent-scoped, and unexpired knowledge library, combines metadata/title/usefulness signals with chunk text matches, and sends up to ten ranked chunks (4,000 characters each) into the model prompt. Retrieved section/source/owner/review metadata remains part of the provenance packet and changes to documents affect subsequent drafts immediately without model training.
- The voice-service API and completion limits now accept the larger database context and 12,000-character drafts. The server-owned system prompt now requires thorough, stage-scaled answers that include relevant explanation, examples or misconceptions, and useful next steps, while preserving concise and source-aware behavior where appropriate.
- Database configuration is no longer sent to the model on each draft request. The application backend pushes a complete shared snapshot to the isolated voice service after agent, behavior-section, and knowledge mutations. The voice service persists that snapshot in its own local SQLite context store and performs ranked retrieval internally for each draft. Draft requests send only the conversation turn, history, stage, tone, and selected agent identifier. Database changes reach the service immediately or remain in a persistent backend outbox until service synchronization succeeds.
- Limitations: chunk ranking is deterministic keyword search, not embeddings or a semantic vector index; it does not verify retrieved facts or guarantee full-document coverage. Database context is assembled for each request and is still persistent application knowledge rather than fine-tuning or internal model memory. The model is not a school-authority oracle and uploaded documents remain untrusted, attributed inputs.
- Verification: Python syntax compilation passed for the changed backend and voice-service modules. Focused tests for chunk retrieval, source filtering, and multi-source draft behavior are required before release; no release gate is complete until those tests pass.

### Detailed debate-agent configuration — 2026-11-19

- The persistent built-in Debate assistant now has a detailed educational purpose and coaching protocol. It is a neutral argument-development agent, not an autonomous opposing participant or an assignment-completion service.
- Its draft protocol requires a neutral restatement, definitions and key question, a claim/evidence structure, separate fact/inference/opinion classification, explicit uncertainty and limitations, strongest-charitable representation of opposing viewpoints, and a stage-appropriate next learner action.
- The protocol separates CER/PEEL, Toulmin, and IB MYP/DP support; Early Years/PYP use concrete and short debate structures, MYP adds claim/evidence/warrant/source evaluation, and DP adds formal argument analysis and methodological limitations. Mature or unsafe subject material remains prohibited regardless of stage.
- Source use follows the shared knowledge database and may cite only approved attributable references or explicitly qualify general/model-generated suggestions. The debate instructions cannot override the fixed child-safety, privacy, truthfulness, safeguarding, or stage rules.
- This is persistent prompt configuration rather than fine-tuning. Educator or database changes affect subsequent debate drafts only and do not rewrite conversation history or previously spoken speech.

### Debate partner agent and expanded database sections — 2026-11-19

- Added a persistent built-in `debate_partner` profile distinct from the existing `debate` coaching profile. The coach helps learners build and evaluate arguments; the partner actively defends one clear position and responds directly to the learner in classroom turn-taking.
- The partner profile requires a confirmed proposition and position, respectful one-claim/one-evidence responses, acknowledgment of a student's strongest point, a rebuttal and constructive challenge, and one focused question or next-turn prompt. It must revise or qualify its position when a student provides a stronger argument.
- The partner may not attack people or identities, humiliate, fabricate evidence or sources, claim human experience or school authority, or introduce unsafe mature or discriminatory material. Higher IB stages add methodological depth but do not weaken safety.
- Each debate partner turn remains suitable for teacher preview, editable draft review, and explicit speech playback. Autonomous interjection, autonomous playback, and motion remain disabled.
- Expanded all eight shared behavior-section defaults beyond one-sentence summaries: persona, role, curriculum, learner support, safeguarding, information use, school context, and spoken personality now include substantial persistent operational guidance. Teacher edits remain higher than agent specialization but lower than fixed system safety.
- The new profile and expanded section guidance are migration-aware: existing installations seed missing built-ins and refresh only the previously default general/debate rows, so intentional teacher edits are preserved. The profile and sections are included in the voice-service context snapshot and outbox synchronization path.

### Detailed integrated behavior database update — 2026-11-19

- Replaced short or one-sentence defaults in all eight behavior sections with detailed operational guidance covering purpose, response structure, stage depth, source boundaries, privacy, safety, school context, and spoken personality.
- Safeguarding guidance now defines an explicit general-response sequence for immediate danger, self-harm, suspected abuse, privacy/alerts, repeated disclosure, and safe communication. It is best-practice baseline guidance only and must be reconciled by CAIS educators and its staffed safeguarding process; it does not create alerts or replace emergency or designated-safeguarding workflows.
- Learner support now defines concrete differences for Early Years, PYP 1-5, MYP 1-5, and DP 1-2, including vocabulary, examples, reasoning, evidence, methodology, and English-language support. Topic suitability remains separate from reading level.
- Information-use guidance now defines source eligibility, prompt-injection defense, attribution, conflicts, review dates, and privacy/retention boundaries. These rules are integrated into the persistent voice-service context rather than recreated only in individual request prompts.
- The public CAIS website was checked for current public context. The app now seeds three attributed, permission-confirmed, review-dated knowledge documents covering its fast facts, Nursery-to-Grade-12/About overview, and learning/community context. Public figures remain review-dated context and must not be presented as verified current policy or enrollment/staffing guarantees.
- A schema migration refreshes only untouched behavior-section defaults. Rows edited by a teacher preserve `updated_by` and are not overwritten. Existing public-website documents are not duplicated. New or changed context is pushed to the voice-service SQLite snapshot and indexed for subsequent drafts.
- Remaining CAIS operational acceptance: upload or approve current CAIS calendar, admissions, safeguarding, disciplinary, health/emergency, and staff procedures. The public-website pack is an information baseline, not authorization for a current school policy claim.

### Later product directions — gated by V1 evidence

- **Richer educator tools:** session deletion, owner-scoped title editing, and user-confirmed plain-text export are implemented. Export includes conversation text and available citations, downloads only to the user's device, and does not include raw audio, session IDs, or credentials. BM25-style lexical ranking is implemented for approved, in-scope, review-current context, but semantic retrieval and retrieval quality evaluation remain future work. The educator-reviewed policy/source proposal workflow is implemented, but it does not verify claims or resolve conflicts automatically. Section guidance, category-scoped documents, stage/agent scoping, shared storage, and the five teacher-preview tone presets remain subject to educator review.
- **Additional language and interaction styles:** evaluate additional languages only after educators review quality, age suitability, and safety in that language.
- **Assisted debate participation:** after reliable manual-playback use, investigate a mode that recommends when to contribute but still requires educator approval. Autonomous interjection remains a separate decision and is not implied by response drafting.
- **Camera and robot capability:** consider camera context and movement only as separately scoped projects with explicit consent, permissions, safety architecture, and physical acceptance tests. They are not extensions that may be enabled by an agent prompt or uploaded knowledge file.
- **Voice choices:** evaluate additional Kokoro voices for clarity, warmth, pace, intelligibility, and appropriate rights/terms with educators before offering them in the teacher preview.
- Teacher-side activity planning and editable agent/behavior context are implemented in the teacher preview; they generate drafts and proposals, not automatic school policy changes.

For each completed or deferred roadmap item, update this living plan with the implementation status, repository/version and licensing record, measured results, known limitations, and the next acceptance gate. Do not mark a repository or feature selected based only on its presence in `ai-agent/research/`.

## Initial interface and data contracts

Keep the first interface small and versioned. Exact endpoint names can be chosen during implementation.

- Teacher conversation text is persisted by the authenticated application backend, owner-scoped, and retained until the teacher clears or deletes it. The live voice stream uses that selected conversation ID for events and drafts; the voice service's separate in-memory `SessionManager` is not the persistence layer.
- The preview loads shared teacher-managed profiles and behavior sections and selects one agent for draft generation. Stage, tone, agent instructions, section guidance, and the matching knowledge excerpts are sent with each request.
- The live stream accepts a `start` control message, fixed-size PCM frames, and `stop`. Current events are speech start, final transcript, speech end, unrecognized speech, explicit error, and stopped. Transcript events carry a session ID, monotonic sequence, and timestamp. Partial transcripts and speaker-change events are not implemented.
- Final transcript turns trigger local draft generation. Existing text-mode controls support edit, regenerate, dismiss, and explicit preparation/playback of speech; draft/playback events are not yet part of the WebSocket protocol.
- Sequence/timestamp checks are applied to numbered transcript events so stale or reordered events cannot be applied within the current page session. Persistent reconnect/replay behavior is not implemented.
- Expose health and model-readiness separately from robot status. Do not report voice-service readiness as robot connectivity or safety readiness.
- Do not expose motion tools or robot SDK calls in the V1 tool registry.

## Verification and release gates

### Automated tests

- Unit tests for audio/session state transitions, transcript ordering, speaker-label assignment, summary/context boundaries, and draft provenance.
- Tests that generated drafts never enter the human transcript and that only confirmed playback is recorded as robot speech.
- Tests for cancel/stop/barge-in races, stale drafts, reconnects, and service/model errors.
- Tests that local mode makes no unapproved external network/model calls, that loss of internet or the approved local inference host does not trigger cloud fallback, and that optional online routes are only used when explicitly enabled.
- Child-safety evaluations for every supported agent/provider, covering age-appropriate answers, unsafe requests, safeguarding disclosures, prompt injection in transcripts/retrieved material, and attempts to bypass safety through custom instructions.
- Stage-calibrated evaluations across Early Years/PYP/MYP/DP for both language complexity and topic/depth suitability, including age-sensitive literature such as *Of Mice and Men* and the same science concept explained at different depths.
- Tests that an unselected stage triggers a greeting followed by a stage question before substantive content, stage changes affect only later output, and custom agents cannot override stage or safety settings.
- Educator-reviewed tests for friendly Formal and Lightly humorous robot-perspective responses, including correct response to "Harry Botter," limited/relevant humor, school appropriateness, and honest AI identity.
- ELL-focused evaluations for clear English, useful explanations/rephrasing, and avoidance of assumed proficiency or culturally narrow examples; test that future language support remains disabled until separately validated.
- Tests that school-context answers use only approved, attributable sources, respect local/offline behavior, disclose uncertainty/staleness, and do not retrieve or expose student/private data.
- Confirm TTS uses a licensed voice that is not a clone or deliberate imitation of an identifiable person.
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
- Have Changchun American International School educators review the IB-stage selector and examples, stage-appropriate topic boundaries, ELL behavior, both initial tones, school-context sources, and the robot's name/persona before classroom use.

Record measured results and unresolved limitations before enabling the optional app surface. Desktop tests, simulators, and model benchmarks alone do not count as G1 audio acceptance.

## Open decisions to resolve during Phase 0

- Which G1 microphone and speaker interfaces are supported by the exact target image, and are they currently used by Uni-EDU or another service?
- Should the first usable interface be a local desktop/web panel, the Uni-EDU Studio UI, or both after the standalone prototype?
- What latency and transcription/diarization quality are acceptable for a classroom debate?
- Confirmed: teacher conversation text persists in the local app database until manually cleared or deleted by its owner; raw audio is never retained. User-confirmed local text export is implemented. Privacy review remains required; encryption at rest and school-level retention governance are not implemented.
- Which Early Years/PYP/MYP/DP stages and subject contexts will be supported first, and what stage-specific topic boundaries and local safeguarding process should educators approve?
- Which licensed TTS voice and non-identifying voice qualities are appropriate for Harry Botter?
- Which Changchun American International School materials may be used as approved context, who owns updates, and how frequently must local copies be reviewed?
- Which additional tones, if any, should follow Formal and Lightly humorous after educator review?
- Which host should run the LLM and speech models after benchmarking: G1 onboard when feasible, or a separately managed local computer on the private network? What minimum functions must remain available on the G1 if that host is offline?
- Which optional online model/provider choices meet the project's child-safety, licensing, privacy, consent, data-retention, and performance requirements?

## Plan maintenance checklist

For every Codespace change that affects this project:

- Update this plan in the same change; do not defer plan updates to a later cleanup.
- Keep the stated scope, actual architecture, dependency/adaptation decisions, and deployment instructions aligned with the code.
- Update phase status and exit criteria only when evidence supports the change; report actual test/hardware results and remaining gaps.
- Preserve the local-first, child-safety, manual-speech-approval, and no-motion boundaries unless a deliberate scope change is reviewed and documented.
- When a repository/component is added, removed, replaced, or directly modified, update the candidate/adaptation record and applicable license/attribution notes.

### Research-stack runtime verification — 2026-11-23

- Reopened the research inventory beyond its original README/manifest screening. The detailed folder disposition and product-path evidence are recorded in `docs/ai-voice-research-audit.md`; repository snapshots remain references, not runtime dependencies.
- Updated the active voice-service context retrieval from raw keyword counts to BM25-style lexical ranking with term rarity, chunk-length normalization, and a bounded metadata relevance boost. Permission confirmation, stage/agent scope, review-date filtering, excerpt limits, and attribution are preserved. Removed a second unused backend knowledge scan; the voice service's synchronized context store is the actual retrieval path. Focused tests confirm focused rare-term passages rank above repetition of a generic query term, and stopword-only queries return no context. This ranking does not establish accuracy, authority, or truth.
- Bootstrapped pip in the existing Python 3.12 voice environment and installed the configured CPU audio extra. The local cache now contains Whisper `tiny.en` and Kokoro weights. The running app reports the local Qwen3 0.6B chat model, transcription, Kokoro speech generation, and WebSocket streaming available.
- Verification: 21 voice API tests, 21 local-model-client tests, 7 streaming/VAD/speaker-tracker tests, 7 live-research/backend-forwarding tests, and 2 Ollama installer tests passed. Live checks verified SearXNG results, Crawl4AI extraction, a Qwen draft with source links, offline Whisper loading, a synthetic Kokoro-to-Whisper round trip, and the audio-stream start/stop lifecycle.
- Replaced in-process web crawling with the authenticated Crawl4AI Docker API. The launcher uses a locally generated bearer token, loopback-only publication, and pinned image digests for Crawl4AI 0.9.5 and SearXNG 2026.11.21. It skips an uncached Crawl4AI image when available memory is below 2 GiB or free Docker storage below 4 GiB. Search results still use SearXNG snippets whenever Docker, the crawler, or network enrichment is unavailable; if SearXNG is also unavailable, normal local chat continues without web context. Focused API and launcher-configuration tests cover the authenticated request, bounded extraction response, and optional fallback.
- The earlier live SearXNG/Crawl4AI search smoke check used the former in-process crawler and does not prove that the new Docker API can complete a live crawl. The pinned image manifests were verified and the new transport/fallback behavior passed mocked tests. This host had about 3 GiB of free Docker storage and 1.3 GiB of available memory, so the optional crawler image was not pulled; container startup and live page extraction remain to be verified on a sufficiently provisioned Docker host.
- Resource limitation: the Codespace has 7.8 GiB RAM and no swap; a separate duplicate Kokoro process was terminated while the managed voice service was running, although managed-service synthesis succeeded. Keep model work serialized; no larger Gemma model was downloaded or benchmarked.
- The streaming speaker assignment is a small session-local spectral heuristic, not validated diarization. Passing synthetic tests does not establish real-speaker accuracy. Physical microphone/speaker/G1 acceptance, noisy-room and human multi-speaker evaluation, full upstream test suites for all 47 research folders, educator approvals, and student-readiness review remain incomplete.
- Source-level follow-up ran 28 focused tests from the standalone `gemma4-agent` snapshot (8 backend, 10 agent-loop, 10 local-tool cases); model/grounding calls were mocked, so this is not a Gemma quality benchmark. The selected Crawl4AI transport now uses the checked-in Docker server's redirect-aware DNS-pinning egress proxy, and the auto-managed SearXNG image is digest-pinned. These changes do not mean the research snapshot commits are recorded, all upstream suites passed, or the complete 47-folder audit is exhaustive.

### Anonymous transcript speaker correction — 2026-11-23

- Added teacher-only per-turn correction for anonymous `Speaker N` labels on saved streaming transcripts when group mode is selected. Corrections persist through the existing owner-scoped conversation endpoint; the API rejects labels that do not use the anonymous format.
- This adapts the VoxNovel speaker-editor interaction only. No VoxNovel source code, dependencies, audio identity features, or batch-book workflow were copied. The current automatic speaker labels remain a provisional session-local spectral heuristic, not validated diarization.
- The label does not change transcript text or model context and cannot encode a person's name through the product API. Failure to save restores the previous visible label and uses the existing conversation-storage error.
- This UI/data-integrity improvement does not complete real-speaker quality, educator/privacy, microphone, or G1 acceptance. Student use remains unapproved.
- Focused anonymous-label API persistence/rejection test and ESLint passed. The full API suite has one separate stale expectation for session settings (it omits the already-supported participant-mode fields). The Playwright UI test could not reach its Vite server (`ERR_CONNECTION_REFUSED`), and the production build was terminated after module transformation (exit 143); browser behavior and full production build remain unverified here.

### Teacher conversation renaming — 2026-11-23

- Adapted the Gemma voice-agent's conversation rename affordance to Harry Botter's existing teacher-owned local session list. A teacher can edit a title in the UI; the API trims and bounds it, verifies session ownership, and persists the custom-title marker so subsequent message saves do not replace the chosen name. Existing auto-generated titles continue to work for sessions that have not been renamed.
- No source code, identity flow, cloud service, model, or dependency was copied from the unlicensed Gemma voice-agent snapshot. Its UI was inspected statically; the demo was not launched because its documented setup requires a dedicated Gemma 4 31B GPU service.
- A focused backend regression covers title normalization, owner isolation, blank-title rejection, and persistence after later message updates. ESLint and the production build validate the UI code. Playwright could not reach its configured frontend; a direct production-browser attempt hit the app's G1 arm-model runtime error before the control could be exercised, so interactive browser behavior remains unverified. This addition does not resolve the broader audit's documented limitation that the full suites and UIs of all 47 snapshots were not run.

### Teacher conversation export — 2026-11-23

- Added an explicit confirmation before downloading a selected teacher conversation as plain text. The export contains the title, stage/tone/agent context, message roles, anonymous transcript labels, and available citations; it omits session IDs, credentials, and raw audio. The file is created in the browser and is not sent to another service.
- The confirmation warns teachers that exported text may contain sensitive information and should be reviewed before sharing. Export remains disabled for empty conversations and while a conversation is changing, drafting, or in a voice session.
- A Node test verifies output attribution/citation formatting and safe filenames. ESLint and the production build validate the UI. Physical-device, privacy/retention, educator, and classroom acceptance remain outstanding.