# Vendored Dependencies

This directory contains our core_componets, as well as third-party code included directly in our repository for stability and independence.

## vibevoice/

**Source:** https://github.com/microsoft/VibeVoice  
**License:** MIT  
**Purpose:** Complete VibeVoice package with both ASR (transcription with speaker diarization) and TTS (long-form multi-speaker synthesis)  
**Reason for vendoring:** Combines ASR and TTS functionality in a single unified package

### Features

**ASR (Automatic Speech Recognition):**
- Transcription with speaker diarization
- Multi-speaker conversation detection
- High-quality speech-to-text

**TTS (Text-to-Speech):**
- Long-form multi-speaker synthesis (up to 90 minutes)
- Up to 4 distinct speakers
- Natural turn-taking and prosody
- Spontaneous background music/sounds (context-aware)
- Cross-lingual support

### Models

Models automatically download from HuggingFace on first use and are cached locally.

### Usage in App

- **Prep Samples Tab:** Uses VibeVoice ASR for transcription with speaker diarization
- **Conversation Tab:** Uses VibeVoice TTS for 90-minute continuous multi-speaker synthesis

### Attribution

VibeVoice is licensed under MIT License. Original copyright:
- Copyright (c) Microsoft Corporation

See LICENSE file in vibevoice/ directory for full license text.

## qwen_finetune/

**Source:** https://github.com/QwenLM/Qwen3-TTS/tree/main/finetuning  
**License:** Apache 2.0  
**Purpose:** Training scripts for fine-tuning Qwen3-TTS models with custom voice samples  
**Reason for vendoring:** Enables user training of custom voice models

### Features

- Fine-tune Qwen3-TTS-Base models (0.6B, 1.7B) with custom voice data
- Train on 24kHz, 16-bit mono audio samples
- Generate custom speaker embeddings
- Automatic audio code extraction and dataset preparation
- Checkpoint-based training with configurable save intervals

### Training Process

1. **Dataset Preparation:** Audio samples (WAV) + transcriptions (TXT)
2. **Code Extraction:** `prepare_data.py` - Extracts audio codes using Qwen3-TTS-Tokenizer
3. **Fine-tuning:** `sft_12hz.py` - Trains model with custom speaker embedding

### Models

Currently supports training with 1.7B Base model only (0.6B support removed due to architecture incompatibility).

### Usage in App

- **Train Model Tab:** Complete training pipeline with validation, preparation, and fine-tuning
- Output models saved to `trained_models_folder` (configurable in settings)
- Trained models available in **Voice Presets Tab** → Trained Models

### Attribution

Qwen3-TTS is licensed under Apache 2.0. Original copyright:
- Copyright 2026 The Alibaba Qwen team

See LICENSE file in qwen_finetune/ directory for full license text.

## Installation

This vendor code is automatically available via sys.path manipulation in the main application.
No separate pip install is required.
