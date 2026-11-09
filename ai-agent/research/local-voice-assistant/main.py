"""Entry point for the voice assistant: VAD by default, push-to-talk or --text as fallbacks."""

import argparse
import re
import threading
import time

import yaml

from assistant import persona as persona_mod
from assistant.audio import PushToTalkRecorder, VADRecorder
from assistant.llm import OllamaClient
from assistant.persona import PersonaState
from assistant.stt import Transcriber
from assistant.tts import Player, Synthesizer, sanitize_for_speech

CONFIG_PATH = "config.yaml"
MAX_HISTORY = 12
CHUNK_MAX_CHARS = 120
MIN_SPEECH_MS = 300
BARGEIN_MS = 250

_SENTENCE_END_RE = re.compile(r"[.!?]")

_STATUS_LABELS = {
    "idle": "IDLE",
    "listening": "LISTENING",
    "thinking": "THINKING",
    "speaking": "SPEAKING",
}


def set_status(state: str) -> None:
    """Overwrite a single status line in the terminal (idle/listening/thinking/speaking)."""
    print(f"\r[{_STATUS_LABELS[state]:<10}]", end="", flush=True)


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def _next_chunk(buffer: str) -> tuple[str, str] | None:
    """Split off one speakable chunk: up to a sentence end, or once buffer is long enough."""
    match = _SENTENCE_END_RE.search(buffer)
    if match:
        return buffer[: match.end()], buffer[match.end() :]
    if len(buffer) >= CHUNK_MAX_CHARS:
        return buffer, ""
    return None


def converse(
    user_text: str,
    client: OllamaClient,
    synthesizer: Synthesizer,
    player: Player,
    system_prompt: str,
    history: list[dict[str, str]],
    on_speaking_start=None,
    interrupt_event: threading.Event | None = None,
    persona_examples: list[dict[str, str]] | None = None,
) -> None:
    """Send user_text through the LLM, printing and speaking the streamed reply.

    History only ever records what the user actually heard. Each sentence-sized
    chunk we hand to TTS is tracked; a chunk counts as "played" only once Player
    confirms it finished naturally (never true for a chunk flush() cut off mid-way,
    or one still queued when that happened). If `interrupt_event` fires partway
    through, generation is cancelled and only the confirmed-played prefix is
    written to history — never the full model output.

    The system prompt is always re-prepended fresh here, and `persona_examples`
    (when given) are spliced in right after it -- neither ever lives inside
    `history`, so MAX_HISTORY truncation below can never drop either of them.
    """
    if interrupt_event is None:
        interrupt_event = threading.Event()  # never set; keeps the checks unconditional

    history.append({"role": "user", "content": user_text})
    history[:] = history[-MAX_HISTORY:]
    messages = [{"role": "system", "content": system_prompt}, *(persona_examples or []), *history]

    chunk_texts: list[str] = []  # raw (pre-sanitize) text of every chunk dispatched, in order
    played_count = 0
    played_lock = threading.Lock()

    def mark_played(index: int) -> None:
        nonlocal played_count
        with played_lock:
            # Playback is strictly in order, so confirming index i implies every
            # chunk before it is done too; track the count monotonically.
            played_count = max(played_count, index + 1)

    request_start = time.monotonic()
    first_token_time = None
    latency_hook_attached = False

    def make_latency_hook():
        def _on_start():
            first_audio_time = time.monotonic()
            print(f"\n[timing] first audio: {first_audio_time - first_token_time:.2f}s after first token")
            if on_speaking_start:
                on_speaking_start()

        return _on_start

    def speak(text: str) -> None:
        nonlocal latency_hook_attached
        index = len(chunk_texts)
        chunk_texts.append(text)
        speech = sanitize_for_speech(text)
        if not speech:
            mark_played(index)  # nothing to play, so nothing to interrupt
            return
        audio = synthesizer.synthesize(speech)
        if audio.size == 0:
            mark_played(index)  # synthesis failed/skipped; not withheld by an interruption
            return
        on_start = None
        if not latency_hook_attached:
            on_start = make_latency_hook()
            latency_hook_attached = True
        player.play(audio, on_start=on_start, on_complete=lambda i=index: mark_played(i))

    interrupted = False
    buffer = ""
    gen = client.stream_chat(messages)
    try:
        for token in gen:
            if interrupt_event.is_set():
                interrupted = True
                break
            if first_token_time is None:
                first_token_time = time.monotonic()
                print(f"\n[timing] LLM first token: {first_token_time - request_start:.2f}s")
            print(token, end="", flush=True)
            buffer += token

            chunk = _next_chunk(buffer)
            while chunk is not None:
                if interrupt_event.is_set():
                    interrupted = True
                    break
                text, buffer = chunk
                speak(text)
                chunk = _next_chunk(buffer)
            if interrupted:
                break
    except ConnectionError as exc:
        print(f"\n[error] {exc}")
        gen.close()
        return
    finally:
        gen.close()
    print()

    if interrupted:
        print("[interrupted]")
        player.flush()  # idempotent if the barge-in handler already flushed
    else:
        speak(buffer)
        _wait_for_playback(player)

    with played_lock:
        final_played_count = played_count
    played_text = "".join(chunk_texts[:final_played_count])
    if played_text.strip():
        history.append({"role": "assistant", "content": played_text})
    history[:] = history[-MAX_HISTORY:]


def _wait_for_playback(player: Player) -> None:
    """Block until playback has been quiet for a bit (debounced against inter-chunk gaps)."""
    time.sleep(0.1)
    quiet_checks = 0
    while quiet_checks < 3:
        quiet_checks = 0 if player.is_playing() else quiet_checks + 1
        time.sleep(0.1)


def speak_line(text: str, synthesizer: Synthesizer, player: Player) -> None:
    """Synthesize and play a single line to completion, outside the normal LLM
    turn -- used for in-character acknowledgements of persona dial commands."""
    speech = sanitize_for_speech(text)
    if not speech:
        return
    audio = synthesizer.synthesize(speech)
    if audio.size == 0:
        return
    player.play(audio)
    _wait_for_playback(player)


def resolve_turn_prompt(
    text: str,
    persona_state: PersonaState | None,
    plain_system_prompt: str,
    synthesizer: Synthesizer,
    player: Player,
) -> tuple[str, list[dict[str, str]]] | None:
    """Resolve the system prompt and few-shot examples to use for this turn.

    If `text` is a persona dial-adjustment command, speaks the in-character
    acknowledgement directly and returns None -- the caller should skip the
    LLM turn entirely in that case.
    """
    if persona_state is None:
        return plain_system_prompt, []

    if persona_state.allow_runtime_adjust:
        ack = persona_mod.try_apply_dial_command(text, persona_state)
        if ack is not None:
            print(f"[persona] {ack}")
            speak_line(ack, synthesizer, player)
            return None

    return persona_state.system_prompt(), persona_state.examples


def run_text_mode(
    client: OllamaClient,
    synthesizer: Synthesizer,
    player: Player,
    plain_system_prompt: str,
    persona_state: PersonaState | None = None,
) -> None:
    history: list[dict[str, str]] = []
    print("Type a message, /reset to clear history, or /quit to exit.")

    while True:
        try:
            user_input = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not user_input:
            continue
        if user_input == "/quit":
            break
        if user_input == "/reset":
            history.clear()
            player.flush()
            print("History cleared.")
            continue

        resolved = resolve_turn_prompt(user_input, persona_state, plain_system_prompt, synthesizer, player)
        if resolved is None:
            continue
        system_prompt, persona_examples = resolved
        converse(
            user_input,
            client,
            synthesizer,
            player,
            system_prompt,
            history,
            persona_examples=persona_examples,
        )


def run_push_to_talk_mode(
    client: OllamaClient,
    synthesizer: Synthesizer,
    player: Player,
    plain_system_prompt: str,
    config: dict,
    persona_state: PersonaState | None = None,
) -> None:
    recorder = PushToTalkRecorder()
    transcriber = Transcriber(
        model_size=config["whisper_model_size"],
        device=config["whisper_device"],
        compute_type=config["whisper_compute_type"],
    )
    history: list[dict[str, str]] = []

    print(f"Hold {recorder.key_name} to talk, release to send. Ctrl+C to quit.")

    while True:
        try:
            audio = recorder.record()
        except KeyboardInterrupt:
            print()
            break

        if audio.size == 0:
            continue

        stt_start = time.monotonic()
        text = transcriber.transcribe(audio)
        print(f"[timing] STT: {time.monotonic() - stt_start:.2f}s")

        if not text:
            print("(nothing heard)")
            continue

        print(f"> {text}")
        resolved = resolve_turn_prompt(text, persona_state, plain_system_prompt, synthesizer, player)
        if resolved is None:
            continue
        system_prompt, persona_examples = resolved
        converse(
            text,
            client,
            synthesizer,
            player,
            system_prompt,
            history,
            persona_examples=persona_examples,
        )


def run_vad_mode(
    client: OllamaClient,
    synthesizer: Synthesizer,
    player: Player,
    plain_system_prompt: str,
    config: dict,
    persona_state: PersonaState | None = None,
) -> None:
    barge_in_enabled = config.get("barge_in", True)

    transcriber = Transcriber(
        model_size=config["whisper_model_size"],
        device=config["whisper_device"],
        compute_type=config["whisper_compute_type"],
    )
    recorder = VADRecorder(
        threshold=config["vad_threshold"],
        silence_ms=config["silence_threshold_ms"],
        min_speech_ms=MIN_SPEECH_MS,
        bargein_ms=BARGEIN_MS,
        on_speech_start=lambda: set_status("listening"),
    )
    recorder.start()
    history: list[dict[str, str]] = []

    print("Listening for speech. Ctrl+C to quit.")

    while True:
        set_status("idle")
        try:
            audio = recorder.get_utterance()
        except KeyboardInterrupt:
            print()
            break

        if audio.size == 0:
            continue

        interrupt_event = threading.Event()

        def on_bargein() -> None:
            player.flush()
            interrupt_event.set()
            set_status("listening")

        if barge_in_enabled:
            recorder.arm_bargein(on_bargein)
        else:
            recorder.mute()

        set_status("thinking")
        stt_start = time.monotonic()
        text = transcriber.transcribe(audio)
        print(f"\n[timing] STT: {time.monotonic() - stt_start:.2f}s")

        if not text:
            print("(nothing heard)")
            recorder.listen_for_next_turn()
            continue

        print(f"> {text}")
        resolved = resolve_turn_prompt(text, persona_state, plain_system_prompt, synthesizer, player)
        if resolved is None:
            recorder.listen_for_next_turn()
            continue
        system_prompt, persona_examples = resolved
        converse(
            text,
            client,
            synthesizer,
            player,
            system_prompt,
            history,
            on_speaking_start=lambda: set_status("speaking"),
            interrupt_event=interrupt_event,
            persona_examples=persona_examples,
        )
        recorder.listen_for_next_turn()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--text", action="store_true", help="Use typed input instead of voice."
    )
    args = parser.parse_args()

    config = load_config(CONFIG_PATH)
    plain_system_prompt = config["system_prompt"]

    persona_state = None
    persona_cfg = config.get("persona", {})
    if persona_cfg.get("enabled", False):
        persona_state = persona_mod.load_persona("persona.yaml", persona_cfg, plain_system_prompt)

    voice = persona_state.voice if persona_state else config["kokoro_voice"]
    temperature = persona_state.temperature if persona_state else None

    client = OllamaClient(
        model=config["ollama_model"], base_url=config["ollama_base_url"], temperature=temperature
    )
    synthesizer = Synthesizer(voice=voice)
    player = Player()

    if args.text:
        run_text_mode(client, synthesizer, player, plain_system_prompt, persona_state)
    elif config.get("push_to_talk", False):
        run_push_to_talk_mode(client, synthesizer, player, plain_system_prompt, config, persona_state)
    else:
        run_vad_mode(client, synthesizer, player, plain_system_prompt, config, persona_state)


if __name__ == "__main__":
    main()
