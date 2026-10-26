#include <chrono>
#include <memory>
#include <vector>
#include <opencv2/opencv.hpp>
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/image.hpp>
#include <cv_bridge/cv_bridge.hpp>
#include <unitree/robot/b2/front_video/front_video_client.hpp>

class G1CameraBridge : public rclcpp::Node {
public:
  G1CameraBridge() : Node("g1_camera_bridge") {
    pub_ = create_publisher<sensor_msgs::msg::Image>("/camera/color/image_raw", 10);

    client_ = std::make_unique<unitree::robot::b2::FrontVideoClient>();
    client_->SetTimeout(3.0);
    client_->Init();

    timer_ = create_wall_timer(
        std::chrono::milliseconds(100),
        std::bind(&G1CameraBridge::grab, this));
    RCLCPP_INFO(get_logger(), "G1 Camera Bridge started");
  }

private:
  void grab() {
    std::vector<uint8_t> jpeg_buf;
    int32_t ret = client_->GetImageSample(jpeg_buf);
    if (ret != 0 || jpeg_buf.empty()) {
      RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 5000,
                           "GetImageSample failed: %d", ret);
      return;
    }
    cv::Mat frame = cv::imdecode(jpeg_buf, cv::IMREAD_COLOR);
    if (frame.empty()) return;

    auto msg = cv_bridge::CvImage(std_msgs::msg::Header(), "bgr8", frame).toImageMsg();
    msg->header.stamp = now();
    msg->header.frame_id = "camera_link";
    pub_->publish(*msg);
  }

  rclcpp::Publisher<sensor_msgs::msg::Image>::SharedPtr pub_;
  std::unique_ptr<unitree::robot::b2::FrontVideoClient> client_;
  rclcpp::TimerBase::SharedPtr timer_;
};

int main(int argc, char** argv) {
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<G1CameraBridge>());
  rclcpp::shutdown();
  return 0;
}
