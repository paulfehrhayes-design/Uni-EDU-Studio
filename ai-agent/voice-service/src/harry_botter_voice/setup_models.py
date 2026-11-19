"""Download the configured local speech models into the Hugging Face cache."""

import gc
import os

from .speech import SUPPORTED_TTS_VOICES, create_kokoro_pipeline, kokoro_language_code


def main() -> None:
    model = os.environ.get(
        "HARRY_BOTTER_WHISPER_MODEL",
        "Systran/faster-whisper-tiny.en",
    )
    device = os.environ.get("HARRY_BOTTER_STT_DEVICE", "cpu")
    compute_type = os.environ.get("HARRY_BOTTER_STT_COMPUTE_TYPE", "int8")
    cpu_threads = int(os.environ.get("HARRY_BOTTER_STT_CPU_THREADS", "2"))
    configured_voice = os.environ.get("HARRY_BOTTER_TTS_VOICE", "af_heart")
    if configured_voice not in SUPPORTED_TTS_VOICES:
        raise SystemExit(
            "HARRY_BOTTER_TTS_VOICE must be a supported Kokoro American English voice."
        )
    voices = list(dict.fromkeys((configured_voice, *SUPPORTED_TTS_VOICES)))

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise SystemExit(
            'Install the optional audio dependencies first with: pip install -e ".[audio]"'
        ) from exc

    print(f"Preparing Whisper model {model}...")
    whisper_model = WhisperModel(
        model,
        device=device,
        compute_type=compute_type,
        cpu_threads=cpu_threads,
    )
    del whisper_model
    gc.collect()
    device = os.environ.get("HARRY_BOTTER_TTS_DEVICE", "cpu")
    for language_code in ("a", "b"):
        language_voices = [
            voice for voice in voices
            if kokoro_language_code(voice) == language_code
        ]
        if not language_voices:
            continue
        print(f"Preparing Kokoro language {language_code}...")
        pipeline = create_kokoro_pipeline(device=device, lang_code=language_code)
        for voice in language_voices:
            print(f"Preparing Kokoro voice {voice}...")
            for _ in pipeline("Local voice setup check.", voice=voice):
                pass
    print("Speech models and the supported generic voices are cached. You can now run the service with HF_HUB_OFFLINE=1.")


if __name__ == "__main__":
    main()
