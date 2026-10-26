#!/bin/bash

# Script to convert all rosbag files to videos
# Usage: ./convert_all_rosbags.sh [fps]

FPS=${1:-10}  # Default FPS is 10 if not provided
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_SCRIPT="$SCRIPT_DIR/rosbag_to_video.py"

echo "Converting all rosbag files to videos with FPS: $FPS"
echo "Script location: $PYTHON_SCRIPT"
echo ""

# Check if Python script exists
if [ ! -f "$PYTHON_SCRIPT" ]; then
    echo "Error: Python script not found at $PYTHON_SCRIPT"
    exit 1
fi

# Find all .bag files in the current directory
bag_files=($(find "$SCRIPT_DIR" -maxdepth 1 -name "*.bag" -type f))

if [ ${#bag_files[@]} -eq 0 ]; then
    echo "No .bag files found in $SCRIPT_DIR"
    exit 1
fi

echo "Found ${#bag_files[@]} rosbag files:"
for bag in "${bag_files[@]}"; do
    echo "  - $(basename "$bag")"
done
echo ""

# Process each rosbag file
for bag_file in "${bag_files[@]}"; do
    bag_name=$(basename "$bag_file" .bag)
    output_video="${bag_name}.mp4"
    
    echo "=========================================="
    echo "Processing: $bag_name"
    echo "Output: $output_video"
    echo "=========================================="
    
    # Run the Python script
    python3 "$PYTHON_SCRIPT" "$bag_file" --output "$output_video" --fps "$FPS"
    
    if [ $? -eq 0 ]; then
        echo "✅ Successfully converted: $bag_name"
    else
        echo "❌ Failed to convert: $bag_name"
    fi
    echo ""
done

echo "Batch conversion completed!"
echo "Check the directory for output video files."
