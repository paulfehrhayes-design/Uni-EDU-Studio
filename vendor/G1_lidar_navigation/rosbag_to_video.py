#!/usr/bin/env python3

import rosbag
import cv2
import numpy as np
import os
import sys
from sensor_msgs.msg import Image, CompressedImage
from cv_bridge import CvBridge
import argparse

def rosbag_to_video(rosbag_path, output_video_path, topic_name, fps=30):
    """
    Convert rosbag camera images to video
    
    Args:
        rosbag_path: Path to the rosbag file
        output_video_path: Path for the output video file
        topic_name: ROS topic name for camera images
        fps: Frames per second for output video
    """
    
    # Initialize CV bridge
    bridge = CvBridge()
    
    # Check if rosbag file exists
    if not os.path.exists(rosbag_path):
        print(f"Error: Rosbag file '{rosbag_path}' not found!")
        return False
    
    print(f"Processing rosbag: {rosbag_path}")
    print(f"Topic: {topic_name}")
    print(f"Output video: {output_video_path}")
    
    try:
        # Open rosbag
        bag = rosbag.Bag(rosbag_path, 'r')
        
        # Get topic info
        topic_info = bag.get_type_and_topic_info()
        if topic_name not in topic_info.topics:
            print(f"Error: Topic '{topic_name}' not found in rosbag!")
            print("Available topics:")
            for topic in topic_info.topics:
                print(f"  - {topic}")
            bag.close()
            return False
        
        # Get message count and frequency info
        msg_count = topic_info.topics[topic_name].message_count
        print(f"Found {msg_count} messages in topic '{topic_name}'")
        
        # Initialize video writer
        video_writer = None
        frame_count = 0
        
        # Process messages
        for topic, msg, t in bag.read_messages(topics=[topic_name]):
            try:
                # Convert ROS image to OpenCV format
                if hasattr(msg, 'format') and 'compressed' in msg.format:
                    # Handle compressed images
                    np_arr = np.frombuffer(msg.data, np.uint8)
                    cv_image = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
                else:
                    # Handle raw images
                    cv_image = bridge.imgmsg_to_cv2(msg, "bgr8")
                
                # Initialize video writer with first frame
                if video_writer is None:
                    height, width = cv_image.shape[:2]
                    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
                    video_writer = cv2.VideoWriter(output_video_path, fourcc, fps, (width, height))
                    print(f"Video writer initialized: {width}x{height} @ {fps} FPS")
                
                # Write frame to video
                video_writer.write(cv_image)
                frame_count += 1
                
                # Progress update
                if frame_count % 100 == 0:
                    print(f"Processed {frame_count}/{msg_count} frames...")
                    
            except Exception as e:
                print(f"Error processing frame {frame_count}: {e}")
                continue
        
        # Clean up
        if video_writer is not None:
            video_writer.release()
        
        bag.close()
        
        print(f"Successfully converted {frame_count} frames to video: {output_video_path}")
        return True
        
    except Exception as e:
        print(f"Error processing rosbag: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description='Convert rosbag camera images to video')
    parser.add_argument('rosbag_path', help='Path to the rosbag file')
    parser.add_argument('--output', '-o', help='Output video path (default: same as rosbag with .mp4 extension)')
    parser.add_argument('--topic', '-t', default='/camera/color/image_raw/compressed', 
                       help='Camera topic name (default: /camera/color/image_raw/compressed)')
    parser.add_argument('--fps', '-f', type=int, default=10, 
                       help='Output video FPS (default: 10)')
    
    args = parser.parse_args()
    
    # Generate output path if not provided
    if args.output is None:
        base_name = os.path.splitext(os.path.basename(args.rosbag_path))[0]
        output_dir = os.path.dirname(args.rosbag_path)
        args.output = os.path.join(output_dir, f"{base_name}.mp4")
    
    # Convert rosbag to video
    success = rosbag_to_video(args.rosbag_path, args.output, args.topic, args.fps)
    
    if success:
        print("Conversion completed successfully!")
    else:
        print("Conversion failed!")
        sys.exit(1)

if __name__ == "__main__":
    main()
