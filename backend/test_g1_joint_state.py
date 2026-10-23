import unittest
import xml.etree.ElementTree as ET
from types import SimpleNamespace
from pathlib import Path

try:
    from .ros.g1_joint_state import JOINT_MOTOR_INDICES, joint_state_values
except ImportError:
    from ros.g1_joint_state import JOINT_MOTOR_INDICES, joint_state_values


class G1JointStateTests(unittest.TestCase):
    def test_maps_supported_23_dof_g1_motor_order_to_urdf_joint_names(self):
        motor_states = [SimpleNamespace(q=float(index)) for index in range(35)]

        names, positions = joint_state_values(motor_states)

        self.assertEqual(len(names), 23)
        self.assertEqual(names[0], "left_hip_pitch_joint")
        self.assertEqual(names[12], "waist_yaw_joint")
        self.assertEqual(names[-1], "right_wrist_roll_joint")
        self.assertEqual(positions, [float(index) for _, index in JOINT_MOTOR_INDICES])

    def test_rejects_short_or_non_finite_lowstate(self):
        with self.assertRaisesRegex(ValueError, "too few motors"):
            joint_state_values([SimpleNamespace(q=0.0)] * 20)

        motor_states = [SimpleNamespace(q=0.0) for _ in range(35)]
        motor_states[12].q = float("nan")
        with self.assertRaisesRegex(ValueError, "non-finite"):
            joint_state_values(motor_states)

    def test_joint_mapping_matches_supported_urdf_revolute_joints(self):
        urdf_path = Path(__file__).resolve().parents[1] / "g1_23dof.urdf.txt"
        root = ET.parse(urdf_path).getroot()
        urdf_joints = {
            joint.get("name")
            for joint in root.findall("joint")
            if joint.get("type") in {"revolute", "continuous"}
        }

        self.assertEqual(set(name for name, _ in JOINT_MOTOR_INDICES), urdf_joints)


if __name__ == "__main__":
    unittest.main()
