export const G1_MODEL_INFO = Object.freeze({
  robotType: 'Unitree G1',
  source: 'URDF',
  sourceFile: 'g1_23dof.urdf.txt',
  baseLink: 'pelvis',
  jointCount: 23,
  joints: [
    'left_hip_pitch_joint',
    'left_hip_roll_joint',
    'left_hip_yaw_joint',
    'left_knee_joint',
    'left_ankle_pitch_joint',
    'left_ankle_roll_joint',
    'right_hip_pitch_joint',
    'right_hip_roll_joint',
    'right_hip_yaw_joint',
    'right_knee_joint',
    'right_ankle_pitch_joint',
    'right_ankle_roll_joint',
    'waist_yaw_joint',
    'left_shoulder_pitch_joint',
    'left_shoulder_roll_joint',
    'left_shoulder_yaw_joint',
    'left_elbow_joint',
    'left_wrist_roll_joint',
    'right_shoulder_pitch_joint',
    'right_shoulder_roll_joint',
    'right_shoulder_yaw_joint',
    'right_elbow_joint',
    'right_wrist_roll_joint',
  ],
});

export function parseG1Urdf(urdfText) {
  if (!urdfText || typeof urdfText !== 'string') {
    return { ...G1_MODEL_INFO };
  }

  const jointMatches = [...urdfText.matchAll(/<joint\s+name="([^"]+)"[^>]*type="revolute"[^>]*>/g)];
  const joints = jointMatches.map((match) => match[1]);
  const links = [...urdfText.matchAll(/<link\s+name="([^"]+)"/g)].map((match) => match[1]);

  return {
    robotType: 'Unitree G1',
    source: 'URDF',
    sourceFile: 'g1_23dof.urdf.txt',
    baseLink: links.includes('pelvis') ? 'pelvis' : (links[0] ?? 'pelvis'),
    jointCount: joints.length,
    joints,
  };
}

export async function fetchG1ModelInfo() {
  const response = await fetch('/api/g1-model');
  if (!response.ok) {
    return { ...G1_MODEL_INFO };
  }

  const data = await response.json();
  return { ...G1_MODEL_INFO, ...data };
}
