# Dockerfile for T5Gemma-TTS Gradio inference
# Usage:
#   docker build -t t5gemma-tts .
#   docker run --gpus all -p 7860:7860 t5gemma-tts

# CUDA version can be specified via build arg
# Available options: cu118, cu121, cu124, cu128
ARG CUDA_VERSION=cu128
ARG PYTHON_VERSION=3.12

# Base image selection based on CUDA version
FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime AS base-cu128
FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime AS base-cu124
FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime AS base-cu121
FROM pytorch/pytorch:2.5.1-cuda11.8-cudnn9-runtime AS base-cu118

# Select the appropriate base image
ARG CUDA_VERSION
FROM base-${CUDA_VERSION} AS runtime

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/app/.cache/huggingface

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --upgrade pip && \
    pip install -r requirements.txt

# Copy application code
COPY . .

# Create cache directory for HuggingFace models
RUN mkdir -p /app/.cache/huggingface

# Expose Gradio port
EXPOSE 7860

# Default command - can be overridden
CMD ["python", "inference_gradio.py", "--model_dir", "Aratako/T5Gemma-TTS-2b-2b", "--port", "7860"]
