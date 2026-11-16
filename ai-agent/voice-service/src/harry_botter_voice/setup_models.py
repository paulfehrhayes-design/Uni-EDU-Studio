"""Download the configured local speech models into the Hugging Face cache."""

import gc
import os

from .speech import create_kokoro_pipeline


def main() -> None:
    model = os.environ.get(
        "HARRY_BOTTER_WHISPER_MODEL",
        "Systran/faster-whisper-tiny.en",
    )
    device = os.environ.get("HARRY_BOTTER_STT_DEVICE", "cpu")
    compute_type = os.environ.get("HARRY_BOTTER_STT_COMPUTE_TYPE", "int8")
    cpu_threads = int(os.environ.get("HARRY_BOTTER_STT_CPU_THREADS", "2"))
    voice = os.environ.get("HARRY_BOTTER_TTS_VOICE", "af_heart")

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
    print("Preparing the Kokoro English model...")
    pipeline = create_kokoro_pipeline(
        device=os.environ.get("HARRY_BOTTER_TTS_DEVICE", "cpu"),
    )
    for _ in pipeline("Local voice setup check.", voice=voice):
        pass
    print("Speech models are cached. You can now run the service with HF_HUB_OFFLINE=1.")


if __name__ == "__main__":
    main()
