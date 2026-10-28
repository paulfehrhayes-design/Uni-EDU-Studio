#pragma once

#include <array>
#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <thread>

class DuetCommandGateway
{
public:
    using ArmJointReader = std::function<std::array<float, 10>()>;
    using ConnectedReader = std::function<bool()>;
    using ExternalArmActiveReader = std::function<bool()>;

    DuetCommandGateway(
        std::string policy_file_path,
        ArmJointReader arm_joint_reader,
        ConnectedReader connected_reader,
        ExternalArmActiveReader external_arm_active_reader
    );
    ~DuetCommandGateway();

    bool start();
    void stop();
    bool enabled() const { return enabled_; }

private:
    void serve();
    void handle_client(int client_fd);
    std::string status_json() const;

    ArmJointReader arm_joint_reader_;
    ConnectedReader connected_reader_;
    ExternalArmActiveReader external_arm_active_reader_;
    std::atomic<bool> stopping_{false};
    bool enabled_ = false;
    int server_fd_ = -1;
    int lock_fd_ = -1;
    std::string socket_path_;
    std::string lock_path_;
    std::string policy_file_path_;
    std::string policy_id_;
    std::string gateway_build_id_;
    bool arm_pose_enabled_ = false;
    bool owns_socket_path_ = false;
    std::thread server_thread_;
};
