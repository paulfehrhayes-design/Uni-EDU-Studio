#include "FSM/State_RLBase.h"
#include "unitree_articulation.h"
#include "isaaclab/envs/mdp/observations/observations.h"
#include "isaaclab/envs/mdp/actions/joint_actions.h"

#include <algorithm>
#include <cmath>
#include <mutex>

State_RLBase::State_RLBase(int state_mode, std::string state_string)
: FSMState(state_mode, state_string) 
{
    auto cfg = param::config["FSM"][state_string];
    auto policy_dir = param::parser_policy_dir(cfg["policy_dir"].as<std::string>());

    env = std::make_unique<isaaclab::ManagerBasedRLEnv>(
        YAML::LoadFile(policy_dir / "params" / "deploy.yaml"),
        std::make_shared<unitree::BaseArticulation<LowState_t::SharedPtr>>(FSMState::lowstate)
    );
    env->alg = std::make_unique<isaaclab::OrtRunner>(policy_dir / "exported" / "policy.onnx");

    this->registered_checks.emplace_back(
        std::make_pair(
            [&]()->bool{ return isaaclab::mdp::bad_orientation(env.get(), 1.0); },
            FSMStringMap.right.at("Passive")
        )
    );

    // Subscribe to upper-body (arm) targets published by the IL / GR00T policy on
    // a dedicated topic (reuses the LowCmd_ IDL, so no new message type). If no
    // message arrives within the timeout the arms fall back to the carry pose.
    arm_sub_ = std::make_shared<unitree::robot::g1::subscription::LowCmd>("rt/arm_targets");
    arm_sub_->set_timeout_ms(200);
    gateway_ = std::make_unique<DuetCommandGateway>(
        (policy_dir / "exported" / "policy.onnx").string(),
        [this]() {
            std::array<float, 10> measured{};
            const auto & joint_ids = env->robot->data.joint_ids_map;
            const int lower_count = (int)env->action_manager->processed_actions().size();
            std::lock_guard<std::mutex> lock(FSMState::lowstate->mutex_);
            for (int i = 0; i < 10; ++i) {
                measured[i] = FSMState::lowstate->msg_.motor_state()[joint_ids[lower_count + i]].q();
            }
            return measured;
        },
        [this]() { return policy_thread_running.load() && !FSMState::lowstate->isTimeout(); },
        [this]() { return !arm_sub_->isTimeout(); }
    );
}

void State_RLBase::run()
{
    (void)duet_gateway::consume_arm_reset_request();

    auto action = env->action_manager->processed_actions();
    auto & jmap = env->robot->data.joint_ids_map;
    auto & qdef = env->robot->data.default_joint_pos;
    const int n = (int)jmap.size();
    const int n_lower = (int)action.size();
    const int n_arm = n - n_lower;

    // One-time init of the ramp buffer to the default (carry) arm pose.
    if (!arm_ramp_init_) {
        arm_q_applied_.assign(n_arm, 0.0f);
        arm_velocity_applied_.assign(n_arm, 0.0f);
        {
            std::lock_guard<std::mutex> lock(FSMState::lowstate->mutex_);
            for (int k = 0; k < n_arm; ++k) {
                const int motor = (int)jmap[n_lower + k];
                arm_q_applied_[k] = FSMState::lowstate->msg_.motor_state()[motor].q();
            }
        }
        arm_ramp_init_ = true;
    }

    // run() is called at ~1 kHz (CtrlFSM), so use a wall-clock dt for the ramp.
    const auto now = std::chrono::steady_clock::now();
    const float dt = arm_first_run_
        ? (float)env->step_dt
        : std::chrono::duration<float>(now - arm_last_tp_).count();
    arm_last_tp_ = now;
    arm_first_run_ = false;
    // "Active" = an IL (GR00T) message arrived within the subscriber timeout.
    const bool external_arm_active = !arm_sub_->isTimeout();
    const auto requested_app_arm_target = duet_gateway::arm_target_override();
    const auto app_arm_target = external_arm_active
        ? std::optional<std::array<float, 10>>{}
        : requested_app_arm_target;
    const bool arm_active = app_arm_target.has_value() || external_arm_active;

    // Ramp rate: fast+transparent while tracking IL; gentle when homing to the
    // default/carry pose (finger-safe); moderate for an app-requested pose.
    const float ARM_RATE_ACTIVE = 20.0f;  // rad/s, transparent tracking of IL
    const float ARM_RATE_RETURN = 0.7f;   // rad/s, gentle homing to default/carry
    const float ARM_RATE_POSE   = 2.0f;   // rad/s, deliberate bounded pose motion
    const float ARM_ACCEL_RETURN = 2.0f;  // rad/s^2, smooth return to carry/default
    const float ARM_ACCEL_POSE = 4.0f;    // rad/s^2, smooth app targets
    float arm_rate;
    if (app_arm_target)                     arm_rate = ARM_RATE_POSE;
    else if (arm_active)                    arm_rate = ARM_RATE_ACTIVE;
    else                                    arm_rate = ARM_RATE_RETURN;
    // Snapshot the IL arm command once (the DDS callback writes msg_ on another
    // thread).
    std::vector<float> il_q(n_arm), il_kp(n_arm), il_kd(n_arm), il_tau(n_arm);
    if (external_arm_active && !app_arm_target) {
        std::lock_guard<std::mutex> lock(arm_sub_->mutex_);
        for (int k = 0; k < n_arm; ++k) {
            const int motor = (int)jmap[n_lower + k];
            il_q[k]   = arm_sub_->msg_.motor_cmd()[motor].q();
            il_kp[k]  = arm_sub_->msg_.motor_cmd()[motor].kp();
            il_kd[k]  = arm_sub_->msg_.motor_cmd()[motor].kd();
            il_tau[k] = arm_sub_->msg_.motor_cmd()[motor].tau();
        }
    }

    for (int i = 0; i < n; ++i) {
        const int motor = (int)jmap[i];
        if (i < n_lower) {
            // Lower body: RL policy.
            lowcmd->msg_.motor_cmd()[motor].q() = action[i];
            continue;
        }
        // Arm joint: follow a live IL/app target, else the default carry pose.
        const int k = i - n_lower;
        float target;
        if (app_arm_target)                                 target = (*app_arm_target)[k];
        else if (external_arm_active)                       target = il_q[k];
        else                                                target = (float)qdef[i];
        const float err = target - arm_q_applied_[k];
        if (external_arm_active && !app_arm_target) {
            const float max_step = ARM_RATE_ACTIVE * dt;
            if (std::fabs(err) <= max_step) {
                arm_q_applied_[k] = target;
                arm_velocity_applied_[k] = 0.0f;
            } else {
                const float step = std::copysign(max_step, err);
                arm_q_applied_[k] += step;
                arm_velocity_applied_[k] = dt > 0.0f ? step / dt : 0.0f;
            }
        } else {
            const float acceleration = app_arm_target ? ARM_ACCEL_POSE : ARM_ACCEL_RETURN;
            const float desired_velocity = std::clamp(err / std::max(dt, 0.001f), -arm_rate, arm_rate);
            const float max_velocity_delta = acceleration * dt;
            arm_velocity_applied_[k] += std::clamp(
                desired_velocity - arm_velocity_applied_[k],
                -max_velocity_delta,
                max_velocity_delta
            );
            const float step = arm_velocity_applied_[k] * dt;
            if (std::fabs(err) <= std::fabs(step)) {
                arm_q_applied_[k] = target;
                arm_velocity_applied_[k] = 0.0f;
            } else {
                arm_q_applied_[k] += step;
            }
        }

        lowcmd->msg_.motor_cmd()[motor].q() = arm_q_applied_[k];
        lowcmd->msg_.motor_cmd()[motor].dq() = external_arm_active && !app_arm_target
            ? 0.0f
            : arm_velocity_applied_[k];
        if (external_arm_active && !app_arm_target) {
            lowcmd->msg_.motor_cmd()[motor].kp() = il_kp[k];
            lowcmd->msg_.motor_cmd()[motor].kd() = il_kd[k];
            lowcmd->msg_.motor_cmd()[motor].tau() = il_tau[k];
        } else {
            lowcmd->msg_.motor_cmd()[motor].tau() = 0;
        }
    }
}