import { createEmptyG1Edu23State, G1_EDU_23_ENV } from './g1Edu23Env.js';
import {
  DUET_ARM_MOTIONS,
  flattenDuetCommands,
  getDuetCommand,
  parseDuetProgram,
} from './duetCommands.js';
import { G1_MODEL_INFO } from './g1ModelRuntime.js';

const FRAME_RATE = 30;
const RADIANS_TO_DEGREES = 180 / Math.PI;
const ARM_POSES = {
  carry: [0.35, 0.18, 0, 0.87, 0, 0.35, -0.18, 0, 0.87, 0],
  forward: [-1.35, 0.5, 0, 0.87, 0, -1.35, -0.5, 0, 0.87, 0],
  box_hold: [-1.25, 0, 0, 0.7, 0, -1.25, 0, 0, 0.7, 0],
};
const ARM_JOINT_NAMES = [
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
];

function appendFrame(frames, state, joints, actions, timeline, elapsed, mode = 'duet-preview') {
  const snapshot = {
    ...state,
    path: [...state.path],
    joints: { ...joints },
    actions: [...actions],
    timeline: [...timeline],
    mode,
    time: Number(elapsed.toFixed(3)),
    collisions: 0,
    blocked: false,
  };
  frames.push(snapshot);
}

function simulateMove(command, frames, state, joints, actions, timeline, elapsed) {
  const [vx, vy, yawRate, duration] = command.values;
  const frameCount = Math.max(1, Math.ceil(duration * FRAME_RATE));
  actions.push({
    label: 'DUET velocity',
    summary: `vx ${vx.toFixed(2)} m/s, vy ${vy.toFixed(2)} m/s, yaw ${yawRate.toFixed(2)} rad/s for ${duration.toFixed(1)} s`,
  });
  timeline.push(actions[actions.length - 1]);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const dt = duration / frameCount;
    const headingRadians = (state.heading * Math.PI) / 180;
    state.x += (vx * Math.cos(headingRadians) - vy * Math.sin(headingRadians)) * dt;
    state.y += (vx * Math.sin(headingRadians) + vy * Math.cos(headingRadians)) * dt;
    state.heading += yawRate * dt * RADIANS_TO_DEGREES;
    state.torsoPitch = vx * 12;
    state.torsoRoll = vy * 12;
    state.path.push({ x: Number(state.x.toFixed(3)), y: Number(state.y.toFixed(3)) });
    elapsed.value += dt;
    const phase = (frame / frameCount) * Math.PI * 2;
    joints.left_hip_pitch_joint = Number((Math.sin(phase) * 12).toFixed(2));
    joints.right_hip_pitch_joint = Number((-Math.sin(phase) * 12).toFixed(2));
    joints.left_knee_pitch_joint = Number((Math.max(0, Math.sin(phase)) * 18).toFixed(2));
    joints.right_knee_pitch_joint = Number((Math.max(0, -Math.sin(phase)) * 18).toFixed(2));
    appendFrame(frames, state, joints, actions, timeline, elapsed.value);
  }
  state.torsoPitch = 0;
  state.torsoRoll = 0;
}

function simulateArmPose(command, frames, state, joints, actions, timeline, elapsed) {
  const target = ARM_POSES[command.values[0]];
  const duration = command.values[1];
  const initial = ARM_JOINT_NAMES.map((name) => joints[name] || 0);
  const targetDegrees = target.map((radians) => radians * RADIANS_TO_DEGREES);
  const frameCount = Math.max(1, Math.ceil(duration * FRAME_RATE));
  actions.push({
    label: 'DUET arm pose',
    summary: `Preview the ${command.values[0].replace('_', ' ')} preset over ${duration.toFixed(1)} s`,
  });
  timeline.push(actions[actions.length - 1]);
  for (let frame = 1; frame <= frameCount; frame += 1) {
    const progress = frame / frameCount;
    ARM_JOINT_NAMES.forEach((name, index) => {
      joints[name] = Number((initial[index] + (targetDegrees[index] - initial[index]) * progress).toFixed(2));
    });
    elapsed.value += duration / frameCount;
    appendFrame(frames, state, joints, actions, timeline, elapsed.value);
  }
}

export function simulateDuetG1Edu23Program(code) {
  const nodes = parseDuetProgram(code);
  const commands = flattenDuetCommands(nodes);
  if (!commands.length) {
    return [{
      ...createEmptyG1Edu23State(),
      status: 'Idle',
      mode: 'duet-preview',
      actions: [{ label: 'Idle', summary: 'Add a DUET command to preview the robot.' }],
    }];
  }
  const state = { ...createEmptyG1Edu23State(), status: 'DUET preview' };
  const joints = Object.fromEntries(G1_MODEL_INFO.joints.map((joint) => [joint, 0]));
  const frames = [];
  const actions = [];
  const timeline = [];
  const elapsed = { value: 0 };
  appendFrame(frames, state, joints, actions, timeline, elapsed.value);

  for (const command of commands) {
    const preset = getDuetCommand(command.method)?.motion;
    if (command.method === 'move' || preset) {
      const movement = preset
        ? { ...command, values: [preset.vx, preset.vy, preset.yawRate, command.values[0]] }
        : command;
      simulateMove(movement, frames, state, joints, actions, timeline, elapsed);
    } else if (command.method === 'arm_pose') {
      simulateArmPose(command, frames, state, joints, actions, timeline, elapsed);
    } else if (command.method === 'arm_motion') {
      DUET_ARM_MOTIONS[command.values[0]].forEach((pose) => {
        simulateArmPose({
          ...command,
          values: [pose, command.values[1]],
        }, frames, state, joints, actions, timeline, elapsed);
      });
    } else if (command.method === 'wait') {
      const [duration] = command.values;
      const frameCount = Math.max(1, Math.ceil(duration * FRAME_RATE));
      actions.push({ label: 'Wait', summary: `Wait for ${duration.toFixed(1)} s` });
      timeline.push(actions[actions.length - 1]);
      for (let frame = 0; frame < frameCount; frame += 1) {
        elapsed.value += duration / frameCount;
        appendFrame(frames, state, joints, actions, timeline, elapsed.value);
      }
    } else if (command.method === 'stop') {
      state.status = 'Stopped';
      actions.push({ label: 'DUET stop', summary: 'Stop requested.' });
      timeline.push(actions[actions.length - 1]);
      appendFrame(frames, state, joints, actions, timeline, elapsed.value);
      break;
    }
  }
  state.status = state.status === 'Stopped' ? 'Stopped' : 'DUET preview complete';
  return frames;
}

export function getDuetSimulationModelInfo() {
  return {
    robotType: G1_EDU_23_ENV.robotType,
    jointCount: G1_MODEL_INFO.jointCount,
    jointNames: [...G1_MODEL_INFO.joints],
    accuracy: 'Command-space preview; learned balance and physical motion are not reproduced.',
  };
}
