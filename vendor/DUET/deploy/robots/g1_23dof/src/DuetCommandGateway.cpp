#include "DuetCommandGateway.h"

#include "duet_command_gateway.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fcntl.h>
#include <iomanip>
#include <iostream>
#include <poll.h>
#include <sstream>
#include <stdexcept>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

namespace
{
constexpr float kMinForward = -0.2f;
constexpr float kMaxForward = 0.3f;
constexpr float kMaxLateral = 0.15f;
constexpr float kMaxYawRate = 0.35f;
constexpr int kMinLeaseMs = 100;
constexpr int kMaxLeaseMs = 500;

const std::array<std::array<float, 2>, 10> kArmBounds{{
    {{-2.0f, 1.0f}}, {{-0.25f, 1.6f}}, {{-1.0f, 1.0f}}, {{-0.5f, 1.6f}}, {{-1.5f, 1.5f}},
    {{-2.0f, 1.0f}}, {{-1.6f, 0.25f}}, {{-1.0f, 1.0f}}, {{-0.5f, 1.6f}}, {{-1.5f, 1.5f}},
}};

std::string json_string(const std::string & value)
{
    std::ostringstream result;
    result << '"';
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') result << '\\' << c;
        else if (c < 0x20) result << ' ';
        else result << c;
    }
    result << '"';
    return result.str();
}

bool parse_finite(std::istringstream & input, float & value)
{
    if (!(input >> value) || !std::isfinite(value)) return false;
    return true;
}

bool parse_lease(std::istringstream & input, int & lease_ms)
{
    if (!(input >> lease_ms)) return false;
    return lease_ms >= kMinLeaseMs && lease_ms <= kMaxLeaseMs;
}

bool send_all(int socket_fd, const std::string & response)
{
    size_t sent = 0;
    while (sent < response.size()) {
        const ssize_t count = send(
            socket_fd,
            response.data() + sent,
            response.size() - sent,
            MSG_NOSIGNAL
        );
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return false;
        sent += static_cast<size_t>(count);
    }
    return true;
}

bool read_request_line(int client_fd, std::string & request)
{
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    char buffer[128];
    bool found_newline = false;
    while (request.size() <= 512 && !found_newline) {
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
            deadline - std::chrono::steady_clock::now()
        ).count();
        if (remaining <= 0) return false;
        pollfd descriptor{client_fd, POLLIN, 0};
        const int ready = poll(&descriptor, 1, static_cast<int>(remaining));
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0 || !(descriptor.revents & POLLIN)) return false;

        const ssize_t count = recv(client_fd, buffer, sizeof(buffer), 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return false;
        for (ssize_t i = 0; i < count; ++i) {
            const char ch = buffer[i];
            if (ch == '\n') {
                found_newline = true;
                for (ssize_t trailing = i + 1; trailing < count; ++trailing) {
                    if (buffer[trailing] != '\r' && buffer[trailing] != ' ' && buffer[trailing] != '\t') {
                        request.push_back('\0');
                        return true;
                    }
                }
                break;
            }
            if (ch != '\r') request.push_back(ch);
            if (request.size() > 512) return true;
        }
    }
    return found_newline && !request.empty();
}

std::array<float, 10> arm_pose_target(const std::string & pose)
{
    if (pose == "carry") {
        return {0.35f, 0.18f, 0.0f, 0.87f, 0.0f, 0.35f, -0.18f, 0.0f, 0.87f, 0.0f};
    }
    if (pose == "forward") {
        return {-1.35f, 0.5f, 0.0f, 0.87f, 0.0f, -1.35f, -0.5f, 0.0f, 0.87f, 0.0f};
    }
    if (pose == "box_hold") {
        return {-1.25f, 0.0f, 0.0f, 0.7f, 0.0f, -1.25f, 0.0f, 0.0f, 0.7f, 0.0f};
    }
    throw std::invalid_argument("unsupported arm pose");
}

std::string read_environment(const char * name)
{
    const char * value = std::getenv(name);
    return value ? value : "";
}

std::string sha256_file(const std::string & path)
{
    int output_pipe[2];
    if (pipe(output_pipe) != 0) throw std::runtime_error("could not create policy hash pipe");
    const pid_t child = fork();
    if (child < 0) {
        close(output_pipe[0]);
        close(output_pipe[1]);
        throw std::runtime_error("could not start policy hash process");
    }
    if (child == 0) {
        dup2(output_pipe[1], STDOUT_FILENO);
        close(output_pipe[0]);
        close(output_pipe[1]);
        execlp("sha256sum", "sha256sum", path.c_str(), static_cast<char *>(nullptr));
        _exit(127);
    }
    close(output_pipe[1]);
    std::string output;
    char buffer[128];
    ssize_t count = 0;
    while ((count = read(output_pipe[0], buffer, sizeof(buffer))) > 0) {
        output.append(buffer, static_cast<size_t>(count));
    }
    close(output_pipe[0]);
    int status = 0;
    if (waitpid(child, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0
        || output.size() < 64) {
        throw std::runtime_error("could not hash the DUET identity file");
    }
    return "sha256:" + output.substr(0, 64);
}
}

DuetCommandGateway::DuetCommandGateway(
    std::string policy_file_path,
    ArmJointReader arm_joint_reader,
    ConnectedReader connected_reader,
    ExternalArmActiveReader external_arm_active_reader
)
    : arm_joint_reader_(std::move(arm_joint_reader)),
      connected_reader_(std::move(connected_reader)),
      external_arm_active_reader_(std::move(external_arm_active_reader)),
      policy_file_path_(std::move(policy_file_path))
{
}

DuetCommandGateway::~DuetCommandGateway()
{
    stop();
}

bool DuetCommandGateway::start()
{
    if (read_environment("DUET_GATEWAY_ENABLED") != "true") {
        std::cerr << "[DUET gateway] Disabled; set DUET_GATEWAY_ENABLED=true to expose the local command socket.\n";
        return false;
    }
    policy_id_ = sha256_file(policy_file_path_);
    gateway_build_id_ = sha256_file("/proc/self/exe");
    arm_pose_enabled_ = read_environment("DUET_ARM_ACCEPT") == "1";

    std::string control_dir = read_environment("DUET_CONTROL_DIR");
    if (control_dir.empty()) {
        const std::string home = read_environment("HOME");
        if (home.empty()) throw std::runtime_error("HOME is required when DUET_CONTROL_DIR is unset");
        control_dir = home + "/.cache/uni-edu-duet";
    }
    if (control_dir.front() != '/') throw std::runtime_error("DUET_CONTROL_DIR must be an absolute path");
    std::filesystem::create_directories(control_dir);
    struct stat control_dir_info{};
    if (stat(control_dir.c_str(), &control_dir_info) != 0 || !S_ISDIR(control_dir_info.st_mode)
        || control_dir_info.st_uid != geteuid()) {
        throw std::runtime_error("DUET_CONTROL_DIR must be a directory owned by the controller user");
    }
    if (chmod(control_dir.c_str(), 0700) != 0) {
        throw std::runtime_error("could not secure DUET_CONTROL_DIR permissions");
    }
    socket_path_ = control_dir + "/controller.sock";
    lock_path_ = control_dir + "/controller.lock";
    if (socket_path_.size() >= sizeof(((sockaddr_un *)nullptr)->sun_path)) {
        throw std::runtime_error("DUET gateway socket path is too long");
    }

    lock_fd_ = open(lock_path_.c_str(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
    struct stat lock_info{};
    if (lock_fd_ < 0 || fstat(lock_fd_, &lock_info) != 0 || !S_ISREG(lock_info.st_mode)
        || lock_info.st_uid != geteuid() || flock(lock_fd_, LOCK_EX | LOCK_NB) != 0) {
        if (lock_fd_ >= 0) close(lock_fd_);
        lock_fd_ = -1;
        throw std::runtime_error("DUET gateway lock is unsafe or owned by another process");
    }
    enabled_ = true;
    if (chmod(lock_path_.c_str(), 0600) != 0) {
        throw std::runtime_error("could not secure DUET gateway lock permissions");
    }

    struct stat existing{};
    if (lstat(socket_path_.c_str(), &existing) == 0) {
        if (!S_ISSOCK(existing.st_mode) || existing.st_uid != geteuid()) {
            throw std::runtime_error("refusing to replace a non-owned DUET gateway socket path");
        }
        if (!socket_path_.empty()) unlink(socket_path_.c_str());
    } else if (errno != ENOENT) {
        throw std::runtime_error("could not inspect the existing DUET gateway socket path");
    }
    server_fd_ = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (server_fd_ < 0) throw std::runtime_error("could not create DUET gateway socket");
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::strncpy(address.sun_path, socket_path_.c_str(), sizeof(address.sun_path) - 1);
    if (bind(server_fd_, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0) {
        const std::string detail = std::strerror(errno);
        close(server_fd_);
        server_fd_ = -1;
        throw std::runtime_error("could not bind DUET gateway socket: " + detail);
    }
    owns_socket_path_ = true;
    if (chmod(socket_path_.c_str(), 0600) != 0 || listen(server_fd_, 8) != 0) {
        const std::string detail = std::strerror(errno);
        throw std::runtime_error("could not configure DUET gateway socket: " + detail);
    }
    stopping_ = false;
    server_thread_ = std::thread(&DuetCommandGateway::serve, this);
    std::cout << "[DUET gateway] Listening on " << socket_path_ << " for policy " << policy_id_ << ".\n";
    return true;
}

void DuetCommandGateway::stop()
{
    if (!enabled_ && lock_fd_ < 0 && server_fd_ < 0) return;
    stopping_ = true;
    if (server_thread_.joinable()) server_thread_.join();
    if (server_fd_ >= 0) {
        shutdown(server_fd_, SHUT_RDWR);
        close(server_fd_);
        server_fd_ = -1;
    }
    if (owns_socket_path_) {
        unlink(socket_path_.c_str());
        owns_socket_path_ = false;
    }
    auto & shared = duet_gateway::state();
    {
        std::lock_guard<std::mutex> lock(shared.mutex);
        shared.control_lease = false;
        shared.velocity_active = false;
        shared.arm_target_active = false;
        shared.arm_reset_requested = false;
        shared.velocity = {0.0f, 0.0f, 0.0f};
    }
    if (lock_fd_ >= 0) {
        flock(lock_fd_, LOCK_UN);
        close(lock_fd_);
        lock_fd_ = -1;
    }
    enabled_ = false;
    std::cout << "[DUET gateway] Stopped; command leases cleared.\n";
}

void DuetCommandGateway::serve()
{
    while (!stopping_) {
        pollfd descriptor{server_fd_, POLLIN, 0};
        const int ready = poll(&descriptor, 1, 100);
        if (ready <= 0 || !(descriptor.revents & POLLIN)) continue;
        const int client_fd = accept4(server_fd_, nullptr, nullptr, SOCK_CLOEXEC);
        if (client_fd < 0) {
            if (stopping_) break;
            continue;
        }
        handle_client(client_fd);
        close(client_fd);
    }
}

std::string DuetCommandGateway::status_json() const
{
    const bool connected = connected_reader_();
    const bool external_arm_active = external_arm_active_reader_();
    auto & shared = duet_gateway::state();
    bool control_lease = false;
    bool velocity_active = false;
    bool arm_active = false;
    {
        std::lock_guard<std::mutex> lock(shared.mutex);
        const auto now = std::chrono::steady_clock::now();
        control_lease = shared.control_lease;
        velocity_active = shared.control_lease && shared.velocity_active
            && now < shared.velocity_deadline
            && (std::fabs(shared.velocity[0]) > 0.001f || std::fabs(shared.velocity[1]) > 0.001f
                || std::fabs(shared.velocity[2]) > 0.001f);
        arm_active = shared.control_lease && shared.arm_target_active && now < shared.arm_target_deadline;
    }
    const auto measured = arm_joint_reader_();
    std::ostringstream result;
    result << std::fixed << std::setprecision(5)
           << "{\"protocol\":\"uni-edu-duet-v1\",\"robot_model\":\"g1_23dof\","
           << "\"policy_id\":" << json_string(policy_id_)
           << ",\"gateway_build_id\":" << json_string(gateway_build_id_)
           << ",\"connected\":" << (connected ? "true" : "false")
           << ",\"ready\":" << (connected ? "true" : "false")
           << ",\"motion_active\":" << (velocity_active ? "true" : "false")
           << ",\"control_lease\":" << (control_lease ? "true" : "false")
           << ",\"lowcmd_owner\":\"duet\",\"arm_targets_active\":" << (arm_active ? "true" : "false")
           << ",\"external_arm_active\":" << (external_arm_active ? "true" : "false")
           << ",\"arm_pose_active\":" << (arm_pose_enabled_ && arm_active ? "true" : "false")
           << ",\"capabilities\":[\"base_velocity\",\"wait\",\"stop\",\"arm_targets\",\"arm_feedback\",\"gateway_identity\"";
    if (arm_pose_enabled_) result << ",\"arm_pose\"";
    result << "],\"measured_joints\":[";
    for (size_t i = 0; i < measured.size(); ++i) {
        if (i) result << ',';
        result << measured[i];
    }
    result << "]}\n";
    return result.str();
}

void DuetCommandGateway::handle_client(int client_fd)
{
    std::string request;
    if (!read_request_line(client_fd, request) || request.empty() || request.size() > 512
        || request.find('\0') != std::string::npos) {
        const std::string response = "{\"error\":\"invalid request length\"}\n";
        send_all(client_fd, response);
        return;
    }
    const auto send_status = [this, client_fd]() {
        const auto response = status_json();
        send_all(client_fd, response);
    };
    std::istringstream input(request);
    std::string operation;
    input >> operation;
    auto & shared = duet_gateway::state();
    try {
        if (operation == "STATUS") {
            send_status();
            return;
        }
        if (operation == "ACQUIRE") {
            std::lock_guard<std::mutex> lock(shared.mutex);
            if (!connected_reader_()) throw std::runtime_error("DUET low state is unavailable");
            shared.control_lease = true;
            shared.velocity_active = false;
            shared.arm_target_active = false;
        } else if (operation == "RELEASE") {
            std::lock_guard<std::mutex> lock(shared.mutex);
            shared.control_lease = false;
            shared.velocity_active = false;
            shared.arm_target_active = false;
            shared.velocity = {0.0f, 0.0f, 0.0f};
        } else if (operation == "MOVE") {
            float vx, vy, yaw;
            int lease_ms;
            if (!parse_finite(input, vx) || !parse_finite(input, vy) || !parse_finite(input, yaw)
                || !parse_lease(input, lease_ms) || std::fabs(vy) > kMaxLateral
                || vx < kMinForward || vx > kMaxForward || std::fabs(yaw) > kMaxYawRate) {
                throw std::runtime_error("MOVE is outside the approved velocity or lease bounds");
            }
            std::string extra;
            if (input >> extra) throw std::runtime_error("MOVE has unexpected arguments");
            std::lock_guard<std::mutex> lock(shared.mutex);
            if (!shared.control_lease) throw std::runtime_error("acquire the DUET control lease before MOVE");
            shared.velocity = {vx, vy, yaw};
            shared.velocity_active = true;
            shared.velocity_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(lease_ms);
        } else if (operation == "ARM_TARGETS") {
            int lease_ms;
            if (!parse_lease(input, lease_ms)) throw std::runtime_error("ARM_TARGETS lease is outside 100-500 ms");
            std::array<float, 10> target{};
            for (size_t i = 0; i < target.size(); ++i) {
                if (!parse_finite(input, target[i]) || target[i] < kArmBounds[i][0] || target[i] > kArmBounds[i][1]) {
                    throw std::runtime_error("ARM_TARGETS contains an invalid or out-of-workspace joint target");
                }
            }
            std::string extra;
            if (input >> extra) throw std::runtime_error("ARM_TARGETS has unexpected arguments");
            if (external_arm_active_reader_()) {
                throw std::runtime_error("an external rt/arm_targets stream is active");
            }
            std::lock_guard<std::mutex> lock(shared.mutex);
            if (!shared.control_lease) throw std::runtime_error("acquire the DUET control lease before ARM_TARGETS");
            shared.arm_target = target;
            shared.arm_target_active = true;
            shared.arm_target_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(lease_ms);
        } else if (operation == "ARM_POSE") {
            std::string pose;
            int lease_ms;
            if (!(input >> pose) || !parse_lease(input, lease_ms)) {
                throw std::runtime_error("ARM_POSE requires a preset and a 100-500 ms lease");
            }
            std::string extra;
            if (input >> extra) throw std::runtime_error("ARM_POSE has unexpected arguments");
            if (!arm_pose_enabled_) throw std::runtime_error("DUET_ARM_ACCEPT=1 is required for arm_pose");
            if (external_arm_active_reader_()) {
                throw std::runtime_error("an external rt/arm_targets stream is active");
            }
            const auto target = arm_pose_target(pose);
            std::lock_guard<std::mutex> lock(shared.mutex);
            if (!shared.control_lease) throw std::runtime_error("acquire the DUET control lease before ARM_POSE");
            shared.arm_target = target;
            shared.arm_target_active = true;
            shared.arm_target_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(lease_ms);
        } else if (operation == "RESET_ARMS") {
            std::lock_guard<std::mutex> lock(shared.mutex);
            if (!shared.control_lease) throw std::runtime_error("acquire the DUET control lease before RESET_ARMS");
            shared.arm_target_active = false;
            shared.arm_reset_requested = true;
        } else if (operation == "STOP") {
            std::lock_guard<std::mutex> lock(shared.mutex);
            shared.velocity_active = false;
            shared.arm_target_active = false;
            shared.velocity = {0.0f, 0.0f, 0.0f};
        } else {
            throw std::runtime_error("unsupported DUET gateway operation");
        }
        std::cout << "[DUET gateway] " << request << " -> accepted\n";
        send_status();
    } catch (const std::exception & error) {
        std::cerr << "[DUET gateway] " << request << " -> rejected: " << error.what() << '\n';
        const auto response = std::string("{\"error\":") + json_string(error.what()) + "}\n";
        send_all(client_fd, response);
    }
}
