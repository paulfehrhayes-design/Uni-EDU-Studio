#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <sstream>
#include <string>

#include "geometry_msgs/msg/twist.hpp"
#include "rclcpp/rclcpp.hpp"
#include "std_srvs/srv/trigger.hpp"
#include "unitree_api/msg/request.hpp"

namespace {

constexpr int64_t kApiSetFsmId = 7101;
constexpr int64_t kApiSetBalanceMode = 7102;
constexpr int64_t kApiSetStandHeight = 7104;
constexpr int64_t kApiSetVelocity = 7105;

constexpr int kFsmZeroTorque = 0;
constexpr int kFsmDamp = 1;
constexpr int kFsmSit = 3;
constexpr int kFsmStandUp = 4;
constexpr int kFsmStart = 500;

double ApplyDeadband(double value, double deadband) {
  return std::abs(value) < deadband ? 0.0 : value;
}

double Clamp(double value, double lower, double upper) {
  return std::clamp(value, lower, upper);
}

}  // namespace

class G1CmdVelBridge : public rclcpp::Node {
 public:
  G1CmdVelBridge() : Node("g1_cmd_vel_bridge") {
    const auto cmd_vel_topic =
        this->declare_parameter<std::string>("cmd_vel_topic", "/cmd_vel");
    const auto request_topic = this->declare_parameter<std::string>(
        "request_topic", "/api/sport/request");

    publish_rate_hz_ =
        this->declare_parameter<double>("publish_rate_hz", 20.0);
    command_timeout_sec_ =
        this->declare_parameter<double>("command_timeout_sec", 0.5);
    command_duration_sec_ =
        this->declare_parameter<double>("command_duration_sec", 0.6);
    max_linear_x_ = this->declare_parameter<double>("max_linear_x", 0.5);
    max_linear_y_ = this->declare_parameter<double>("max_linear_y", 0.3);
    max_angular_z_ = this->declare_parameter<double>("max_angular_z", 0.8);
    deadband_linear_ =
        this->declare_parameter<double>("deadband_linear", 1e-3);
    deadband_angular_ =
        this->declare_parameter<double>("deadband_angular", 1e-3);
    auto_start_ = this->declare_parameter<bool>("auto_start", false);
    send_stop_on_startup_ =
        this->declare_parameter<bool>("send_stop_on_startup", true);

    if (publish_rate_hz_ <= 0.0) {
      throw std::invalid_argument("publish_rate_hz must be > 0");
    }
    if (command_timeout_sec_ <= 0.0) {
      throw std::invalid_argument("command_timeout_sec must be > 0");
    }
    if (command_duration_sec_ <= 0.0) {
      throw std::invalid_argument("command_duration_sec must be > 0");
    }

    request_pub_ = this->create_publisher<unitree_api::msg::Request>(
        request_topic, rclcpp::QoS(10));

    cmd_vel_sub_ = this->create_subscription<geometry_msgs::msg::Twist>(
        cmd_vel_topic, rclcpp::SensorDataQoS(),
        std::bind(&G1CmdVelBridge::HandleCmdVel, this, std::placeholders::_1));

    const auto timer_period = std::chrono::duration<double>(1.0 / publish_rate_hz_);
    publish_timer_ = this->create_wall_timer(
        std::chrono::duration_cast<std::chrono::nanoseconds>(timer_period),
        std::bind(&G1CmdVelBridge::HandlePublishTimer, this));

    CreateTriggerService("start", [this]() {
      PublishDataRequest(kApiSetFsmId, kFsmStart);
      started_once_ = true;
      return std::string("published Start (fsm=500)");
    });
    CreateTriggerService("damp", [this]() {
      PublishDataRequest(kApiSetFsmId, kFsmDamp);
      return std::string("published Damp (fsm=1)");
    });
    CreateTriggerService("stand_up", [this]() {
      PublishDataRequest(kApiSetFsmId, kFsmStandUp);
      return std::string("published StandUp (fsm=4)");
    });
    CreateTriggerService("sit", [this]() {
      PublishDataRequest(kApiSetFsmId, kFsmSit);
      return std::string("published Sit (fsm=3)");
    });
    CreateTriggerService("zero_torque", [this]() {
      PublishDataRequest(kApiSetFsmId, kFsmZeroTorque);
      return std::string("published ZeroTorque (fsm=0)");
    });
    CreateTriggerService("high_stand", [this]() {
      PublishDataRequest(
          kApiSetStandHeight,
          static_cast<double>(std::numeric_limits<uint32_t>::max()));
      return std::string("published HighStand");
    });
    CreateTriggerService("low_stand", [this]() {
      PublishDataRequest(kApiSetStandHeight, 0.0);
      return std::string("published LowStand");
    });
    CreateTriggerService("balance_stand", [this]() {
      PublishDataRequest(kApiSetBalanceMode, 0);
      return std::string("published BalanceStand");
    });
    CreateTriggerService("stop", [this]() {
      PublishVelocity(0.0, 0.0, 0.0, command_duration_sec_);
      stop_sent_ = true;
      return std::string("published zero velocity");
    });

    last_cmd_stamp_ = this->now();
    RCLCPP_INFO(this->get_logger(),
                "G1 cmd_vel bridge ready. cmd_vel -> %s, request topic -> %s",
                cmd_vel_topic.c_str(), request_topic.c_str());
  }

 private:
  void HandleCmdVel(const geometry_msgs::msg::Twist::SharedPtr msg) {
    last_cmd_.linear.x =
        Clamp(ApplyDeadband(msg->linear.x, deadband_linear_), -max_linear_x_,
              max_linear_x_);
    last_cmd_.linear.y =
        Clamp(ApplyDeadband(msg->linear.y, deadband_linear_), -max_linear_y_,
              max_linear_y_);
    last_cmd_.angular.z = Clamp(
        ApplyDeadband(msg->angular.z, deadband_angular_), -max_angular_z_,
        max_angular_z_);

    last_cmd_stamp_ = this->now();
    have_cmd_ = true;
    stop_sent_ = false;
  }

  void HandlePublishTimer() {
    const auto now = this->now();

    if (!have_cmd_) {
      if (send_stop_on_startup_ && !stop_sent_) {
        PublishVelocity(0.0, 0.0, 0.0, command_duration_sec_);
        stop_sent_ = true;
      }
      return;
    }

    const auto age = (now - last_cmd_stamp_).seconds();
    if (age <= command_timeout_sec_) {
      if (auto_start_ && !started_once_ && HasNonZeroVelocity(last_cmd_)) {
        PublishDataRequest(kApiSetFsmId, kFsmStart);
        started_once_ = true;
        RCLCPP_WARN(this->get_logger(),
                    "auto_start=true, published Start (fsm=500) before velocity");
      }

      PublishVelocity(last_cmd_.linear.x, last_cmd_.linear.y,
                      last_cmd_.angular.z, command_duration_sec_);
      stop_sent_ = false;
      return;
    }

    if (!stop_sent_) {
      PublishVelocity(0.0, 0.0, 0.0, command_duration_sec_);
      stop_sent_ = true;
      RCLCPP_WARN(this->get_logger(),
                  "cmd_vel timeout reached, published zero velocity");
    }
  }

  bool HasNonZeroVelocity(const geometry_msgs::msg::Twist &twist) const {
    return std::abs(twist.linear.x) > 0.0 || std::abs(twist.linear.y) > 0.0 ||
           std::abs(twist.angular.z) > 0.0;
  }

  void PublishVelocity(double vx, double vy, double omega, double duration) {
    std::ostringstream parameter;
    parameter << "{\"velocity\":["
              << vx << "," << vy << "," << omega
              << "],\"duration\":" << duration << "}";
    PublishRequest(kApiSetVelocity, parameter.str());
  }

  void PublishDataRequest(int64_t api_id, int value) {
    std::ostringstream parameter;
    parameter << "{\"data\":" << value << "}";
    PublishRequest(api_id, parameter.str());
  }

  void PublishDataRequest(int64_t api_id, double value) {
    std::ostringstream parameter;
    parameter << "{\"data\":" << value << "}";
    PublishRequest(api_id, parameter.str());
  }

  void PublishRequest(int64_t api_id, const std::string &parameter) {
    unitree_api::msg::Request request;
    request.header.identity.id = this->get_clock()->now().nanoseconds();
    request.header.identity.api_id = api_id;
    request.parameter = parameter;
    request_pub_->publish(request);
  }

  void CreateTriggerService(
      const std::string &name,
      const std::function<std::string()> &publish_callback) {
    trigger_services_.push_back(this->create_service<std_srvs::srv::Trigger>(
        name,
        [this, publish_callback](
            const std::shared_ptr<std_srvs::srv::Trigger::Request> /*request*/,
            std::shared_ptr<std_srvs::srv::Trigger::Response> response) {
          response->success = true;
          response->message = publish_callback();
          RCLCPP_INFO(this->get_logger(), "%s", response->message.c_str());
        }));
  }

  rclcpp::Publisher<unitree_api::msg::Request>::SharedPtr request_pub_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr cmd_vel_sub_;
  rclcpp::TimerBase::SharedPtr publish_timer_;
  std::vector<rclcpp::Service<std_srvs::srv::Trigger>::SharedPtr>
      trigger_services_;

  geometry_msgs::msg::Twist last_cmd_;
  rclcpp::Time last_cmd_stamp_{0, 0, RCL_ROS_TIME};
  bool have_cmd_{false};
  bool stop_sent_{false};
  bool started_once_{false};
  bool auto_start_{false};
  bool send_stop_on_startup_{true};

  double publish_rate_hz_{20.0};
  double command_timeout_sec_{0.5};
  double command_duration_sec_{0.6};
  double max_linear_x_{0.5};
  double max_linear_y_{0.3};
  double max_angular_z_{0.8};
  double deadband_linear_{1e-3};
  double deadband_angular_{1e-3};
};

int main(int argc, char *argv[]) {
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<G1CmdVelBridge>());
  rclcpp::shutdown();
  return 0;
}
