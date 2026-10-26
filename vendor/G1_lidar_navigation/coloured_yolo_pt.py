#!/usr/bin/env python3
import rospy
import cv2
import numpy as np
import struct
import sys
import time
from sensor_msgs.msg import Image, PointCloud2, PointField, CameraInfo
from detection_msgs.msg import BoundingBox, BoundingBoxes
from geometry_msgs.msg import PoseStamped
import sensor_msgs.point_cloud2 as pc2
from cv_bridge import CvBridge, CvBridgeError
import tf2_ros
import geometry_msgs.msg
from transforms3d.euler import euler2mat

# ---------------------------
# Global Variables
# ---------------------------
bridge = CvBridge()
latest_image = None
pub_colored = None
camera_info = None
tf_buffer = None
tf_listener = None
latest_detections = None
target_class = None  # Will store the class to target if specified
last_goal_time = 0.0  # Last time a goal was published

def get_camera_transform():
    """Create transform from body to camera_color_optical_frame"""
    try:
        # Define transformation similar to the working code
        # The transformation matrix maps:
        # body frame (x forward, y left, z up) to
        # camera optical frame (z forward, x right, y down)
        transform = np.array([
            [0,  1,  0, -0.05],   # Camera X = Body Y
            [0,  0,  1, 0.10],    # Camera Y = Body Z
            [1,  0,  0, -0.1],    # Camera Z = Body X
            [0,  0,  0,  1]], dtype=np.float32)
        
        rospy.loginfo_throttle(5, f"Transform matrix:\n{transform}")
        return transform
        
    except Exception as e:
        rospy.logerr(f"Transform Error: {e}")
        return None

def camera_info_callback(info_msg):
    """Callback for camera calibration info"""
    global camera_info
    camera_info = info_msg
    camera_info_sub.unregister()
    rospy.loginfo("Received camera calibration information")
    rospy.loginfo(f"Camera matrix K:\n{np.array(camera_info.K).reshape(3,3)}")

def convert_rgb_to_float(r, g, b):
    """Pack RGB values (0-255) into a single float32 value."""
    rgb = (int(r) << 16) | (int(g) << 8) | int(b)
    return struct.unpack('f', struct.pack('I', rgb))[0]

def image_callback(img_msg):
    """Callback for RGB image"""
    global latest_image
    try:
        latest_image = bridge.imgmsg_to_cv2(img_msg, "bgr8")
    except CvBridgeError as e:
        rospy.logerr(f"CvBridge Error: {e}")

def detections_callback(detections_msg):
    """Callback for YOLO detections"""
    global latest_detections
    latest_detections = detections_msg
    process_detections()

def visualize_projections(image, points_2d, total_colored, detections=None):
    """Visualize the projected points and detections on the image"""
    if image is None:
        return
        
    debug_image = image.copy()
    
    # Draw all projected points
    for u, v in points_2d:
        cv2.circle(debug_image, (int(u), int(v)), 1, (0, 255, 0), -1)  # Green dots
    
    # Draw bounding boxes if available
    if detections is not None:
        for bbox in detections.bounding_boxes:
            # Skip if we have a target class and this isn't it
            if target_class and target_class.lower() != bbox.Class.lower():
                color = (0, 165, 255)  # Orange for non-target classes
            else:
                color = (0, 255, 0)  # Green for target class
            
            # Draw bounding box
            cv2.rectangle(debug_image, 
                         (bbox.xmin, bbox.ymin), 
                         (bbox.xmax, bbox.ymax), 
                         color, 2)
            
            # Add label
            label = f"{bbox.Class}: {bbox.probability:.2f}"
            cv2.putText(debug_image, label, 
                       (bbox.xmin, bbox.ymin - 10), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
    
    # Add text showing number of points
    cv2.putText(debug_image, f"Colored Points: {total_colored}", 
                (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
    
    # Show time until next goal can be published
    time_since_last = time.time() - last_goal_time
    time_to_next = max(0, 10 - time_since_last)
    cv2.putText(debug_image, f"Next goal in: {time_to_next:.1f}s", 
                (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
    
    # Show the image
    cv2.imshow("Projected Points", debug_image)
    cv2.waitKey(1)

def get_3d_point_from_bbox(bbox, T_body_to_cam, K):
    """Get 3D point from center of bounding box"""
    if latest_image is None or camera_info is None:
        return None

    # Get bbox center
    center_x = int((bbox.xmin + bbox.xmax) / 2)
    center_y = int((bbox.ymin + bbox.ymax) / 2)

    # Get corresponding 3D points around center
    points_3d = []
    radius = 5  # Search radius around center point

    for point in pc2.read_points(latest_cloud, skip_nans=True):
        pt_body = np.array([point[0], point[1], point[2], 1.0])
        pt_cam = T_body_to_cam.dot(pt_body)

        if pt_cam[2] <= 0:
            continue

        # Project point to image
        pt_img = K.dot(pt_cam[:3])
        u = int(pt_img[0] / pt_img[2])
        v = int(pt_img[1] / pt_img[2])

        # Check if point projects near bbox center
        if (abs(u - center_x) <= radius and 
            abs(v - center_y) <= radius and
            0 <= u < camera_info.width and 
            0 <= v < camera_info.height):
            points_3d.append(pt_body[:3])  # Store point in body frame

    if points_3d:
        # Return median of points to reduce noise
        return np.median(points_3d, axis=0)
    return None

def transform_to_map(point_body):
    """Transform point from body frame to map frame"""
    try:
        transform = tf_buffer.lookup_transform(
            'map',
            'body',
            rospy.Time(0),
            rospy.Duration(1.0)
        )

        # Convert transform to matrix
        q = transform.transform.rotation
        t = transform.transform.translation

        # Create transformation matrix
        T_body_to_map = np.eye(4)
        
        # Convert quaternion to rotation matrix
        T_body_to_map[:3, :3] = np.array([
            [1 - 2*q.y*q.y - 2*q.z*q.z, 2*q.x*q.y - 2*q.z*q.w, 2*q.x*q.z + 2*q.y*q.w],
            [2*q.x*q.y + 2*q.z*q.w, 1 - 2*q.x*q.x - 2*q.z*q.z, 2*q.y*q.z - 2*q.x*q.w],
            [2*q.x*q.z - 2*q.y*q.w, 2*q.y*q.z + 2*q.x*q.w, 1 - 2*q.x*q.x - 2*q.y*q.y]
        ])
        
        # Add translation
        T_body_to_map[0:3, 3] = [t.x, t.y, t.z]

        # Transform point
        point_homog = np.append(point_body, 1)
        point_map = T_body_to_map.dot(point_homog)
        
        return point_map[:3]

    except (tf2_ros.LookupException, tf2_ros.ConnectivityException, 
            tf2_ros.ExtrapolationException) as e:
        rospy.logerr(f"TF Error: {e}")
        return None

def publish_goal(point_map, object_class):
    """Publish goal position for navigation"""
    global last_goal_time
    
    # Check if enough time has passed since last goal
    current_time = time.time()
    if current_time - last_goal_time < 10.0:  # Only publish every 10 seconds
        time_left = 10.0 - (current_time - last_goal_time)
        rospy.loginfo(f"Waiting {time_left:.1f} more seconds before publishing next goal")
        return False
    
    goal_pub = rospy.Publisher('/move_base_simple/goal', PoseStamped, queue_size=1)
    
    goal_msg = PoseStamped()
    goal_msg.header.frame_id = "robot_foot_init"
    goal_msg.header.stamp = rospy.Time.now()
    
    goal_msg.pose.position.x = point_map[0]
    goal_msg.pose.position.y = point_map[1]
    goal_msg.pose.position.z = 0.0  # Keep on ground plane
    
    # Set orientation to identity (no rotation)
    goal_msg.pose.orientation.w = 1.0
    goal_msg.pose.orientation.x = 0.0
    goal_msg.pose.orientation.y = 0.0
    goal_msg.pose.orientation.z = 0.0
    
    goal_pub.publish(goal_msg)
    last_goal_time = current_time
    rospy.loginfo(f"Published navigation goal for {object_class} at position: {point_map}")
    return True

def process_detections():
    """Process detections to set navigation goals"""
    global latest_detections, latest_image, latest_cloud
    
    if latest_detections is None or latest_image is None or latest_cloud is None or camera_info is None:
        return
    
    # Get camera transform and intrinsics
    T_body_to_cam = get_camera_transform()
    if T_body_to_cam is None:
        return
        
    K = np.array(camera_info.K).reshape(3,3)
    
    # Process each detection
    for detection in latest_detections.bounding_boxes:
        # Skip if not target class (if target_class is specified)
        if target_class and target_class.lower() != detection.Class.lower():
            continue
            
        # Get 3D position in body frame
        point_body = get_3d_point_from_bbox(detection, T_body_to_cam, K)
        if point_body is None:
            rospy.logwarn_throttle(5, f"Could not get 3D position for {detection.Class}")
            continue
            
        # Transform to map frame
        point_map = transform_to_map(point_body)
        if point_map is None:
            continue
            
        # Try to publish goal (will only publish if enough time has passed)
        if publish_goal(point_map, detection.Class):
            # Log successful detection and goal publication
            rospy.loginfo(f"Detected {detection.Class} at image position ({detection.xmin}, {detection.ymin}) - " 
                         f"3D position in map frame: {point_map}")

def pointcloud_callback(cloud_msg):
    """Callback for point cloud data"""
    global latest_image, pub_colored, camera_info, latest_cloud
    
    latest_cloud = cloud_msg
    
    if latest_image is None:
        rospy.logwarn_throttle(1, "No image received yet")
        return
    if camera_info is None:
        rospy.logwarn_throttle(1, "No camera info received yet")
        return

    # Get current transform
    T_body_to_cam = get_camera_transform()
    if T_body_to_cam is None:
        return

    # Get camera intrinsic matrix
    K = np.array(camera_info.K).reshape(3,3)

    colored_points = []
    points_2d = []
    field_names = [field.name for field in cloud_msg.fields]
    total_points = 0
    behind_camera = 0
    outside_bounds = 0
    colored_count = 0

    # No rotation - straight forward
    R_adjust = np.array([[1, 0, 0, 0],
                        [0, 1, 0, 0],
                        [0, 0, 1, 0],
                        [0, 0, 0, 1]], dtype=np.float32)

    try:
        for point in pc2.read_points(cloud_msg, skip_nans=True, field_names=field_names):
            total_points += 1
            
            # Point is in body frame
            pt_body = np.array([point[0], point[1], point[2], 1.0], dtype=np.float32)
            
            # Transform to camera frame only for projection
            pt_cam = T_body_to_cam.dot(pt_body)

            # Debug every 1000th point
            if total_points % 1000 == 0:
                rospy.loginfo_throttle(1, f"Sample point - Body frame: {pt_body[:3]}, Camera frame: {pt_cam[:3]}")

            # Skip points behind the camera
            if pt_cam[2] <= 0:
                behind_camera += 1
                continue

            # Project to image plane
            pt_img_homog = K.dot(pt_cam[:3])
            u = pt_img_homog[0] / pt_img_homog[2]
            v = pt_img_homog[1] / pt_img_homog[2]
            u_int = int(u)
            v_int = int(v)

            # Debug projection of sample points
            if total_points % 1000 == 0:
                rospy.loginfo_throttle(1, f"Projected point - u: {u_int}, v: {v_int}")

            # Check if point projects within image bounds
            if (0 <= u_int < camera_info.width) and (0 <= v_int < camera_info.height):
                try:
                    b, g, r = latest_image[v_int, u_int]
                    rgb_float = convert_rgb_to_float(r, g, b)
                    
                    # Transform point for visualization (rotate to face forward)
                    pt_viz = R_adjust.dot(pt_body)
                    colored_points.append([pt_viz[0], pt_viz[1], pt_viz[2], rgb_float])
                    colored_count += 1
                    points_2d.append((u_int, v_int))
                except IndexError:
                    continue
            else:
                outside_bounds += 1

    except Exception as e:
        rospy.logerr(f"Error processing point cloud: {e}")
        return

    # Create and publish colored pointcloud
    if colored_points:
        fields = [
            PointField("x", 0, PointField.FLOAT32, 1),
            PointField("y", 4, PointField.FLOAT32, 1),
            PointField("z", 8, PointField.FLOAT32, 1),
            PointField("rgb", 12, PointField.FLOAT32, 1)
        ]
        
        header = cloud_msg.header
        # Use the original frame_id to maintain orientation
        header.frame_id = cloud_msg.header.frame_id
        colored_cloud = pc2.create_cloud(header, fields, colored_points)
        pub_colored.publish(colored_cloud)

    # Print detailed statistics
    rospy.loginfo_throttle(1, f"""Point cloud statistics:
        Total points: {total_points}
        Points behind camera: {behind_camera}
        Points outside image: {outside_bounds}
        Colored points: {colored_count}
    """)

    # Visualize projections with detections
    visualize_projections(latest_image, points_2d, colored_count, latest_detections)

if __name__ == '__main__':
    try:
        rospy.init_node("colored_pointcloud_node", anonymous=True)
        
        # Get target class from command line if provided
        if len(sys.argv) > 1:
            target_class = sys.argv[1]
            rospy.loginfo(f"Targeting objects of class: {target_class}")
        else:
            rospy.loginfo("No target class specified. Will process all detections.")
        
        # Setup TF listener
        tf_buffer = tf2_ros.Buffer()
        tf_listener = tf2_ros.TransformListener(tf_buffer)
        
        rospy.loginfo("Waiting for camera info...")
        # Wait for camera info first
        camera_info_sub = rospy.Subscriber(
            "/camera/color/camera_info",
            CameraInfo,
            camera_info_callback,
            queue_size=1
        )
        
        # Wait until we have camera info
        while camera_info is None and not rospy.is_shutdown():
            rospy.sleep(0.1)
        
        rospy.loginfo("Camera info received. Setting up remaining subscribers...")
        
        # Setup subscribers
        rospy.Subscriber("/camera/color/image_raw", Image, image_callback, queue_size=1)
        rospy.Subscriber("/cloud_registered_body", PointCloud2, pointcloud_callback, queue_size=1)
        rospy.Subscriber("/yolov5/detections", BoundingBoxes, detections_callback, queue_size=1)
        
        # Publisher for colored point cloud
        pub_colored = rospy.Publisher("/colored_pointcloud", PointCloud2, queue_size=1)
        
        rospy.loginfo("Colored point cloud node started. Subscribed to image and point cloud topics.")
        
        rospy.spin()
        
    except rospy.ROSInterruptException:
        cv2.destroyAllWindows()  # Clean up windows
        rospy.loginfo("Node shutdown requested.")
    except Exception as e:
        cv2.destroyAllWindows()  # Clean up windows
        rospy.logerr(f"Unexpected error: {e}")