#!/bin/bash
# Linux launcher for Voice Clone Studio

echo "========================================"
echo "Voice Clone Studio"
echo "========================================"
echo ""

source venv/bin/activate

echo "Starting Voice Clone Studio..."
echo "Checking available engines..."
echo ""

python voice_clone_studio.py
