#include <memory>
#include <string>
#include <vector>

#include "g1_bridge_bringup/g1_joint_names.hpp"
#include "rclcpp/rclcpp.hpp"
#include "sensor_msgs/msg/imu.hpp"
#include "sensor_msgs/msg/joint_state.hpp"
#include "unitree_hg/msg/low_state.hpp"

class G1LowStateBridge : public rclcpp::Node {
 public:
  G1LowStateBridge() : Node("g1_low_state_bridge") {
    const auto source_topic =
        this->declare_parameter<std::string>("source_topic", "lowstate");
    const auto joint_layout_str =
        this->declare_parameter<std::string>("joint_layout", "g1_29dof");
    const auto joint_state_topic =
        this->declare_parameter<std::string>("joint_state_topic", "joint_states");
    const auto imu_topic =
        this->declare_parameter<std::string>("imu_topic", "imu/data");
    imu_frame_id_ =
        this->declare_parameter<std::string>("imu_frame_id", "base_imu_link");
    publish_joint_states_ =
        this->declare_parameter<bool>("publish_joint_states", true);
    publish_imu_ = this->declare_parameter<bool>("publish_imu", true);

    joint_layout_ = g1_bridge_bringup::ParseJointLayout(joint_layout_str);
    joint_indices_ = g1_bridge_bringup::JointIndicesForLayout(joint_layout_);
    joint_names_ = g1_bridge_bringup::JointNamesForLayout(joint_layout_);

    if (publish_joint_states_) {
      joint_state_pub_ =
          this->create_publisher<sensor_msgs::msg::JointState>(joint_state_topic,
                                                               rclcpp::QoS(50));
    }

    if (publish_imu_) {
      imu_pub_ =
          this->create_publisher<sensor_msgs::msg::Imu>(imu_topic, rclcpp::QoS(50));
    }

    low_state_sub_ = this->create_subscription<unitree_hg::msg::LowState>(
        source_topic, rclcpp::SensorDataQoS(),
        std::bind(&G1LowStateBridge::HandleLowState, this, std::placeholders::_1));

    RCLCPP_INFO(this->get_logger(),
                "G1 low state bridge ready. source=%s, layout=%s",
                source_topic.c_str(), joint_layout_str.c_str());
  }

 private:
  void HandleLowState(const unitree_hg::msg::LowState::SharedPtr msg) {
    const auto stamp = this->now();

    if (publish_joint_states_) {
      sensor_msgs::msg::JointState joint_state;
      joint_state.header.stamp = stamp;
      joint_state.name = joint_names_;
      joint_state.position.resize(joint_indices_.size());
      joint_state.velocity.resize(joint_indices_.size());
      joint_state.effort.resize(joint_indices_.size());

      for (size_t i = 0; i < joint_indices_.size(); ++i) {
        const auto index = static_cast<size_t>(joint_indices_[i]);
        const auto &motor_state = msg->motor_state[index];
        joint_state.position[i] = motor_state.q;
        joint_state.velocity[i] = motor_state.dq;
        joint_state.effort[i] = motor_state.tau_est;
      }

      joint_state_pub_->publish(joint_state);
    }

    if (publish_imu_) {
      sensor_msgs::msg::Imu imu;
      imu.header.stamp = stamp;
      imu.header.frame_id = imu_frame_id_;

      // Unitree IMU quaternion order is [w, x, y, z].
      imu.orientation.w = msg->imu_state.quaternion[0];
      imu.orientation.x = msg->imu_state.quaternion[1];
      imu.orientation.y = msg->imu_state.quaternion[2];
      imu.orientation.z = msg->imu_state.quaternion[3];

      imu.angular_velocity.x = msg->imu_state.gyroscope[0];
      imu.angular_velocity.y = msg->imu_state.gyroscope[1];
      imu.angular_velocity.z = msg->imu_state.gyroscope[2];

      imu.linear_acceleration.x = msg->imu_state.accelerometer[0];
      imu.linear_acceleration.y = msg->imu_state.accelerometer[1];
      imu.linear_acceleration.z = msg->imu_state.accelerometer[2];

      imu.orientation_covariance[0] = -1.0;
      imu.orientation_covariance[4] = -1.0;
      imu.orientation_covariance[8] = -1.0;

      imu.angular_velocity_covariance[0] = 1e-3;
      imu.angular_velocity_covariance[4] = 1e-3;
      imu.angular_velocity_covariance[8] = 1e-3;

      imu.linear_acceleration_covariance[0] = 1e-2;
      imu.linear_acceleration_covariance[4] = 1e-2;
      imu.linear_acceleration_covariance[8] = 1e-2;

      imu_pub_->publish(imu);
    }
  }

  g1_bridge_bringup::JointLayout joint_layout_{
      g1_bridge_bringup::JointLayout::kG1_29Dof};
  std::vector<int> joint_indices_;
  std::vector<std::string> joint_names_;
  std::string imu_frame_id_;
  bool publish_joint_states_{true};
  bool publish_imu_{true};

  rclcpp::Subscription<unitree_hg::msg::LowState>::SharedPtr low_state_sub_;
  rclcpp::Publisher<sensor_msgs::msg::JointState>::SharedPtr joint_state_pub_;
  rclcpp::Publisher<sensor_msgs::msg::Imu>::SharedPtr imu_pub_;
};

int main(int argc, char *argv[]) {
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<G1LowStateBridge>());
  rclcpp::shutdown();
  return 0;
}
