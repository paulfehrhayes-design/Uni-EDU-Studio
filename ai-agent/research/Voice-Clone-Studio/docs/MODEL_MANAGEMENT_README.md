# AI Models Management

Centralized management system for all AI models (TTS, ASR) used in Voice Clone Studio.

## Overview

Instead of having model loading/unloading logic scattered throughout the codebase, all AI model management is now centralized in `modules/core_components/ai_models/`.

This makes it easy to:
- Add support for new TTS/ASR models
- Change model implementations globally
- Optimize VRAM usage
- Test models independently

## Structure

```
modules/core_components/ai_models/
├── __init__.py           # Package exports
├── model_utils.py        # Shared utilities
├── tts_manager.py        # TTS models (Qwen3, VibeVoice)
└── asr_manager.py        # ASR models (Whisper, VibeVoice ASR)
```

## Usage

### TTS Manager

```python
from modules.core_components.ai_models import get_tts_manager

# Get global TTS manager instance
tts_manager = get_tts_manager(user_config, samples_dir)

# Load specific models
qwen3_model = tts_manager.get_qwen3_base(size="1.7B")
voice_design_model = tts_manager.get_qwen3_voice_design()
custom_voice_model = tts_manager.get_qwen3_custom_voice(size="0.6B")
vibevoice_model = tts_manager.get_vibevoice_tts(size="1.5B")

# Fish Speech S2 Pro (4B model, ~24GB VRAM, 80+ languages)
# Vendored in modules/fish_speech/ — Fish Audio Research License
fish_speech = tts_manager.get_fish_speech()

# Unload all when done
tts_manager.unload_all()

# Voice prompt caching
hash = tts_manager.compute_sample_hash(wav_path, ref_text)
prompt = tts_manager.load_voice_prompt(sample_name, hash)
if not prompt:
    prompt = model.create_voice_clone_prompt(...)
    tts_manager.save_voice_prompt(sample_name, prompt, hash)
```

### ASR Manager

```python
from modules.core_components.ai_models import get_asr_manager

# Get global ASR manager instance
asr_manager = get_asr_manager(user_config)

# Check availability
if asr_manager.whisper_available:
    whisper_model = asr_manager.get_whisper()
    result = whisper_model.transcribe("audio.wav")
else:
    vibevoice_model = asr_manager.get_vibevoice_asr()
    result = vibevoice_model.transcribe("audio.wav")

# Unload all when done
asr_manager.unload_all()
```

## Components

### `model_utils.py`

Shared utilities for all models:

- `get_device()` - Return CUDA or CPU device
- `get_dtype(device)` - Return appropriate dtype for device
- `get_attention_implementation(preference)` - Get list of attention mechanisms to try
- `check_model_available_locally(model_name)` - Check if model cached locally
- `empty_cuda_cache()` - Free GPU memory
- `log_gpu_memory(label)` - Display current GPU usage

### `tts_manager.py`

TTS Model Manager:

**Features:**
- Lazy loading of Qwen3 Base, VoiceDesign, CustomVoice models
- VibeVoice TTS support (Small, Large, Large 4-bit)
- Automatic model switching with VRAM optimization
- Voice prompt caching with hash validation
- Configurable attention mechanism selection

**Methods:**
- `get_qwen3_base(size)` - Load Qwen3 Base TTS
- `get_qwen3_voice_design()` - Load Qwen3 VoiceDesign
- `get_qwen3_custom_voice(size)` - Load Qwen3 CustomVoice
- `get_vibevoice_tts(size)` - Load VibeVoice TTS
- `get_fish_speech()` - Load Fish Speech S2 Pro
- `unload_all()` - Free all VRAM
- `compute_sample_hash(wav_path, ref_text)` - Hash sample
- `load_voice_prompt(sample_name, hash, model_size)` - Load cached prompt
- `save_voice_prompt(sample_name, prompt, hash, model_size)` - Cache prompt

### `asr_manager.py`

ASR Model Manager:

**Features:**
- Whisper ASR support with local caching
- VibeVoice ASR for multi-speaker transcription
- Automatic availability detection
- Attention mechanism selection
- Compatible output format

**Methods:**
- `get_whisper()` - Load Whisper ASR
- `get_vibevoice_asr()` - Load VibeVoice ASR
- `unload_all()` - Free all VRAM
- `whisper_available` - Boolean property

## Adding New Models

### Adding a New TTS Model

1. Add loading method to `TTSManager`:

```python
def get_new_tts_model(self, size="default"):
    """Load NewTTS model."""
    model_id = f"new_tts_{size}"
    self._check_and_unload_if_different(model_id)
    
    if self._new_tts_model is None:
        model_path = f"namespace/NewTTS-{size}"
        self._new_tts_model, _ = self._load_model_with_attention(
            NewTTSModelClass,
            model_path,
            device_map="cuda:0",
            dtype=torch.bfloat16,
            low_cpu_mem_usage=self.user_config.get("low_cpu_mem_usage", False)
        )
        print(f"NewTTS ({size}) loaded!")
    
    return self._new_tts_model
```

2. Update tools to use the new model:

```python
from modules.core_components.ai_models import get_tts_manager

tts_manager = get_tts_manager()
model = tts_manager.get_new_tts_model()
audio = model.generate(text)
```

### Adding a New ASR Model

Follow the same pattern in `ASRManager`:

```python
def get_new_asr_model(self):
    """Load NewASR model."""
    self._check_and_unload_if_different("new_asr")
    
    if self._new_asr_model is None:
        self._new_asr_model, _ = self._load_model_with_attention(
            NewASRModelClass,
            "namespace/NewASR",
            ...
        )
        print("NewASR loaded!")
    
    return self._new_asr_model
```

## Configuration

User configuration (`config.json`) controls:

```json
{
    "attention_mechanism": "auto",      // "flash_attention_2", "sdpa", "eager"
    "low_cpu_mem_usage": false,         // Reduce CPU memory
    "offline_mode": false               // Only use local models
}
```

## Benefits

✅ **Centralized** - All model code in one location  
✅ **Consistent** - Same patterns for all models  
✅ **Testable** - Easy to unit test  
✅ **Extensible** - Add new models without touching tools  
✅ **Optimized** - Smart VRAM management  
✅ **Configurable** - User control over model behavior  

## Fish Speech S2 Pro

Fish Speech S2 Pro is a 4B parameter TTS model supporting 80+ languages with inline emotion tags.

**Details:**
- Model: `fishaudio/s2-pro` on HuggingFace (~24GB VRAM)
- Architecture: DualARTransformer + custom DAC audio codec
- License: Fish Audio Research License (free for non-commercial use, commercial requires license)
- Vendored source: `modules/fish_speech/` (inference-only subset)
- Dependencies: `descript-audio-codec`, `hydra-core`, `loguru`

**Emotion Tags:**
Fish Speech uses inline tags in text: `[happy]Hello![/happy]`, `[sad]Oh no[/sad]`

**Generation Parameters:**
- `temperature` (0.7-1.0, default 0.8)
- `top_p` (0.7-0.95, default 0.8)
- `top_k` (1-100, default 30)
- `repetition_penalty` (1.0-1.2, default 1.1)
- `max_new_tokens` (0=auto, up to 4096)
- `chunk_length` (100-512, default 300)

**Note:** The protobuf version conflict between `descript-audiotools` (pins `<3.20`) and `onnxruntime` (needs `>=4.25.1`) is resolved by force-upgrading protobuf to 5.x+ after installation. Both packages work at runtime despite the declared constraint.

## Future Improvements

- [ ] Model preloading for faster startup
- [ ] Per-model configuration
- [ ] Model benchmarking utilities
- [ ] Fallback model selection
- [ ] Multi-GPU support
