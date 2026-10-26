#!/usr/bin/env python3
import rospy
import cv2
import numpy as np
import struct
from sensor_msgs.msg import Image, PointCloud2, PointField, CameraInfo
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

def get_camera_transform():
    """Create transform from body to camera_color_optical_frame"""
    try:
        # Define transformation similar to the working code
        # The transformation matrix maps:
        # body frame (x forward, y left, z up) to
        # camera optical frame (z forward, x right, y down)
        transform = np.array([
            [0,  1,  0, 0.1],   # Camera X = Body Y
            [0,  0,  1, 0.02],    # Camera Y = Body Z
            [1,  0,  0, 0.1],    # Camera Z = Body X
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

def visualize_projections(image, points_2d, total_colored):
    """Visualize the projected points on the image"""
    if image is None:
        return
        
    debug_image = image.copy()
    
    # Draw all projected points
    for u, v in points_2d:
        cv2.circle(debug_image, (int(u), int(v)), 1, (0, 255, 0), -1)  # Green dots
    
    # Add text showing number of points
    cv2.putText(debug_image, f"Colored Points: {total_colored}", 
                (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
    
    # Show the image
    cv2.imshow("Projected Points", debug_image)
    cv2.waitKey(1)

def pointcloud_callback(cloud_msg):
    """Callback for point cloud data"""
    global latest_image, pub_colored, camera_info
    
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

    # Define rotation matrix to make points face forward in RViz
    # Rotate 90 degrees around Z-axis to make it face forward
    R_adjust = np.array([[0, -1, 0, 0],   # Rotate 90 degrees around Z
                        [1,  0, 0, -0.1],
                        [0,  0, 1, -0.175],
                        [0,  0, 0, 1]], dtype=np.float32)

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
        header.frame_id = "camera_color_optical_frame"
        colored_cloud = pc2.create_cloud(header, fields, colored_points)
        pub_colored.publish(colored_cloud)

    # Print detailed statistics
    rospy.loginfo_throttle(1, f"""Point cloud statistics:
        Total points: {total_points}
        Points behind camera: {behind_camera}
        Points outside image: {outside_bounds}
        Colored points: {colored_count}
    """)

    # Visualize projections
    visualize_projections(latest_image, points_2d, colored_count)

if __name__ == '__main__':
    try:
        rospy.init_node("colored_pointcloud_node", anonymous=True)
        
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
