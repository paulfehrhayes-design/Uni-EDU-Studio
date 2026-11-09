try:
    from importlib.metadata import version
    __version__ = version("chatterbox-tts")
except Exception:
    __version__ = "0.2.1"  # Vendored version


from .tts import ChatterboxTTS
from .vc import ChatterboxVC
from .mtl_tts import ChatterboxMultilingualTTS, SUPPORTED_LANGUAGES