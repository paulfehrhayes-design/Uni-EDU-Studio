#pragma once

#include <stdexcept>
#include <string>
#include <vector>

namespace g1_bridge_bringup {

enum class JointLayout {
  kG1_23Dof,
  kG1_29Dof,
};

inline JointLayout ParseJointLayout(const std::string &layout) {
  if (layout == "g1_23dof") {
    return JointLayout::kG1_23Dof;
  }
  if (layout == "g1_29dof") {
    return JointLayout::kG1_29Dof;
  }

  throw std::invalid_argument(
      "joint_layout must be either 'g1_23dof' or 'g1_29dof'");
}

inline const std::vector<int> &JointIndicesForLayout(JointLayout layout) {
  static const std::vector<int> kG1_23DofIndices = {
      0,  1,  2,  3,  4,  5,   6,  7,  8,  9,  10, 11,
      12, 15, 16, 17, 18, 19, 22, 23, 24, 25, 26,
  };

  static const std::vector<int> kG1_29DofIndices = {
      0,  1,  2,  3,  4,  5,  6,  7,  8,  9,
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
      20, 21, 22, 23, 24, 25, 26, 27, 28,
  };

  return layout == JointLayout::kG1_23Dof ? kG1_23DofIndices
                                          : kG1_29DofIndices;
}

inline const std::vector<std::string> &JointNamesForLayout(JointLayout layout) {
  static const std::vector<std::string> kG1_23DofNames = {
      "left_hip_pitch_joint",      "left_hip_roll_joint",
      "left_hip_yaw_joint",        "left_knee_joint",
      "left_ankle_pitch_joint",    "left_ankle_roll_joint",
      "right_hip_pitch_joint",     "right_hip_roll_joint",
      "right_hip_yaw_joint",       "right_knee_joint",
      "right_ankle_pitch_joint",   "right_ankle_roll_joint",
      "waist_yaw_joint",           "left_shoulder_pitch_joint",
      "left_shoulder_roll_joint",  "left_shoulder_yaw_joint",
      "left_elbow_joint",          "left_wrist_roll_joint",
      "right_shoulder_pitch_joint","right_shoulder_roll_joint",
      "right_shoulder_yaw_joint",  "right_elbow_joint",
      "right_wrist_roll_joint",
  };

  static const std::vector<std::string> kG1_29DofNames = {
      "left_hip_pitch_joint",       "left_hip_roll_joint",
      "left_hip_yaw_joint",         "left_knee_joint",
      "left_ankle_pitch_joint",     "left_ankle_roll_joint",
      "right_hip_pitch_joint",      "right_hip_roll_joint",
      "right_hip_yaw_joint",        "right_knee_joint",
      "right_ankle_pitch_joint",    "right_ankle_roll_joint",
      "waist_yaw_joint",            "waist_roll_joint",
      "waist_pitch_joint",          "left_shoulder_pitch_joint",
      "left_shoulder_roll_joint",   "left_shoulder_yaw_joint",
      "left_elbow_joint",           "left_wrist_roll_joint",
      "left_wrist_pitch_joint",     "left_wrist_yaw_joint",
      "right_shoulder_pitch_joint", "right_shoulder_roll_joint",
      "right_shoulder_yaw_joint",   "right_elbow_joint",
      "right_wrist_roll_joint",     "right_wrist_pitch_joint",
      "right_wrist_yaw_joint",
  };

  return layout == JointLayout::kG1_23Dof ? kG1_23DofNames
                                          : kG1_29DofNames;
}

}  // namespace g1_bridge_bringup
