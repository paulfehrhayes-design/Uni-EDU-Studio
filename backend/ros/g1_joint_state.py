import math


JOINT_MOTOR_INDICES = (
    ("left_hip_pitch_joint", 0),
    ("left_hip_roll_joint", 1),
    ("left_hip_yaw_joint", 2),
    ("left_knee_joint", 3),
    ("left_ankle_pitch_joint", 4),
    ("left_ankle_roll_joint", 5),
    ("right_hip_pitch_joint", 6),
    ("right_hip_roll_joint", 7),
    ("right_hip_yaw_joint", 8),
    ("right_knee_joint", 9),
    ("right_ankle_pitch_joint", 10),
    ("right_ankle_roll_joint", 11),
    ("waist_yaw_joint", 12),
    ("left_shoulder_pitch_joint", 15),
    ("left_shoulder_roll_joint", 16),
    ("left_shoulder_yaw_joint", 17),
    ("left_elbow_joint", 18),
    ("left_wrist_roll_joint", 19),
    ("right_shoulder_pitch_joint", 22),
    ("right_shoulder_roll_joint", 23),
    ("right_shoulder_yaw_joint", 24),
    ("right_elbow_joint", 25),
    ("right_wrist_roll_joint", 26),
)


def joint_state_values(motor_states):
    if len(motor_states) <= max(index for _, index in JOINT_MOTOR_INDICES):
        raise ValueError("G1 LowState has too few motors for the supported 23-DoF model.")
    names = []
    positions = []
    for joint_name, motor_index in JOINT_MOTOR_INDICES:
        position = float(motor_states[motor_index].q)
        if not math.isfinite(position):
            raise ValueError(
                "G1 LowState contains a non-finite position for {}.".format(joint_name)
            )
        names.append(joint_name)
        positions.append(position)
    return names, positions
