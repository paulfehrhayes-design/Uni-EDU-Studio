#pragma once

#include <cstddef>

#include "FSMState.h"

// Startup state: keep a current pose in the command buffer without publishing it.
// The first publication is made by FixStand only after the configured operator
// transition is received.
class State_Handoff : public FSMState
{
public:
    State_Handoff(int state, std::string state_string = "Handoff")
    : FSMState(state, state_string)
    {
        // FSMState normally sends a low-state timeout to Passive. That would
        // publish commands before the operator's explicit handoff, so this state
        // deliberately remains non-publishing on timeout.
        if (!registered_checks.empty()) {
            registered_checks.pop_back();
        }

        // Do not accept a stale joystick value or transition unless this cycle
        // copied a complete, fresh joint pose into the command buffer.
        for (auto &check : registered_checks) {
            auto input_check = check.first;
            check.first = [this, input_check]() {
                return pose_ready_ &&
                       FSMState::lowstate &&
                       !FSMState::lowstate->isTimeout() &&
                       input_check();
            };
        }
    }

    void enter() override
    {
        pose_ready_ = false;
    }

    void run() override
    {
        pose_ready_ = false;
        if (!FSMState::lowstate || !FSMState::lowcmd ||
            FSMState::lowstate->isTimeout()) {
            return;
        }

        auto &motor_states = FSMState::lowstate->msg_.motor_state();
        auto &motor_commands = FSMState::lowcmd->msg_.motor_cmd();
        if (motor_states.size() != motor_commands.size()) {
            return;
        }

        for (std::size_t i = 0; i < motor_commands.size(); ++i) {
            motor_commands[i].q() = motor_states[i].q();
        }
        pose_ready_ = true;
    }

    void post_run() override
    {
        // Intentionally do not call FSMState::post_run(): that publishes lowcmd.
    }

private:
    bool pose_ready_ = false;
};

REGISTER_FSM(State_Handoff)
