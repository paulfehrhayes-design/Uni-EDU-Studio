#pragma once

#include <array>
#include <chrono>
#include <cmath>
#include <mutex>
#include <optional>

namespace duet_gateway
{

struct CommandState
{
    std::mutex mutex;
    bool control_lease = false;
    bool velocity_active = false;
    bool arm_target_active = false;
    bool arm_reset_requested = false;
    std::array<float, 3> velocity{0.0f, 0.0f, 0.0f};
    std::array<float, 10> arm_target{};
    std::chrono::steady_clock::time_point velocity_deadline{};
    std::chrono::steady_clock::time_point arm_target_deadline{};
};

inline CommandState & state()
{
    static CommandState instance;
    return instance;
}

inline std::optional<std::array<float, 3>> velocity_override()
{
    auto & shared = state();
    std::lock_guard<std::mutex> lock(shared.mutex);
    if (!shared.control_lease) return std::nullopt;
    if (!shared.velocity_active || std::chrono::steady_clock::now() >= shared.velocity_deadline) {
        shared.velocity_active = false;
        shared.velocity = {0.0f, 0.0f, 0.0f};
    }
    return shared.velocity;
}

inline std::optional<std::array<float, 10>> arm_target_override()
{
    auto & shared = state();
    std::lock_guard<std::mutex> lock(shared.mutex);
    if (!shared.control_lease || !shared.arm_target_active
        || std::chrono::steady_clock::now() >= shared.arm_target_deadline) {
        shared.arm_target_active = false;
        return std::nullopt;
    }
    return shared.arm_target;
}

inline bool control_lease_active()
{
    auto & shared = state();
    std::lock_guard<std::mutex> lock(shared.mutex);
    return shared.control_lease;
}

inline bool consume_arm_reset_request()
{
    auto & shared = state();
    std::lock_guard<std::mutex> lock(shared.mutex);
    const bool requested = shared.arm_reset_requested;
    shared.arm_reset_requested = false;
    return requested;
}

} // namespace duet_gateway
