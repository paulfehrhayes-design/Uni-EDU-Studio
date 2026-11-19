"""Download and initialize the optional local Qwen3 VoiceDesign model."""

from .speech import create_qwen_voice_design_model


def main() -> None:
    model = create_qwen_voice_design_model()
    del model
    print("Qwen3 VoiceDesign model is ready for local, offline use.")


if __name__ == "__main__":
    main()
