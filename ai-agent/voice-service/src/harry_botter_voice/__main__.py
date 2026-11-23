"""Command-line entry point for the local voice service."""

import argparse

from .api import make_server


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local Harry Botter voice service.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--stream-port", type=int, default=8766)
    args = parser.parse_args()

    with make_server(port=args.port) as server:
        print(f"Harry Botter voice service listening on http://127.0.0.1:{server.server_port}")
        stream_status = server.speech_runtime.status()["streaming_transcription"]
        stream_server = None
        stream_thread = None
        if stream_status["available"]:
            try:
                from .streaming import start_audio_stream_server

                stream_server, stream_thread = start_audio_stream_server(
                    server.speech_runtime,
                    port=args.stream_port,
                )
                print(f"Harry Botter audio stream listening on ws://127.0.0.1:{args.stream_port}")
            except (ImportError, OSError) as exc:
                print(
                    f"Live audio streaming is unavailable ({exc}); "
                    "install the audio extra to enable it."
                )
        else:
            print("Live audio streaming is unavailable; install the audio extra to enable it.")
        try:
            server.serve_forever()
        finally:
            if stream_server is not None:
                stream_server.shutdown()
                stream_thread.join(timeout=3)


if __name__ == "__main__":
    main()
