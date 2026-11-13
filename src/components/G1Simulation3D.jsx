import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronLeft,
  ChevronRight, ChevronUp, Grip, Minus, Pause, Play,
  Plus, RotateCcw,
} from 'lucide-react';
import { buildG1SimulationFrames, G1_EDU_23_ENV } from '../sim/g1Edu23Env';
import { simulateDuetG1Edu23Program } from '../sim/duetG1Edu23Env';
import {
  clampMujocoJointAngle, composeMujocoJointQuaternion, convertMujocoAxisToView, getMujocoJointAngle,
} from '../sim/g1MeshRigAxes.js';
import { interpolateSimulationFrame } from '../sim/g1MotionInterpolation.js';
import { buildG1RecordedArmMotionFrames } from '../sim/g1RecordedArmMotion.js';
import { getSceneObjectScale } from '../sim/sceneObjects';
import {
  DEFAULT_CAMERA_DISTANCE, DEFAULT_CAMERA_PITCH, DEFAULT_CAMERA_TARGET_HEIGHT,
  DEFAULT_CAMERA_YAW, getCameraHorizontalFocusOffset, getCameraPanDirection, getCameraPanTargetOffset,
} from '../sim/cameraNavigation';

const JOINT_AXES = {
  left_hip_pitch: 'x', right_hip_pitch: 'x', left_knee: 'x', right_knee: 'x', left_knee_pitch: 'x', right_knee_pitch: 'x',
  left_ankle_pitch: 'x', right_ankle_pitch: 'x',
  left_hip_roll: 'z', right_hip_roll: 'z', left_ankle_roll: 'z', right_ankle_roll: 'z',
  left_hip_yaw: 'y', right_hip_yaw: 'y', waist_yaw: 'y',
  left_shoulder_pitch: 'x', right_shoulder_pitch: 'x', left_elbow: 'x', right_elbow: 'x',
  left_shoulder_roll: 'z', right_shoulder_roll: 'z', left_shoulder_yaw: 'y', right_shoulder_yaw: 'y',
  left_wrist_roll: 'y', right_wrist_roll: 'y',
};

function material(color, metalness = 0.35, roughness = 0.42) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

function addBox(parent, size, position, color, radius = 0.04) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(color));
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  if (radius) {
    mesh.geometry.translate(0, 0, 0);
  }
  return mesh;
}

function createObstacleMesh(obstacle) {
  const group = new THREE.Group();
  const size = Math.max(0.45, Number(obstacle.radius) / 10 || 1);
  const dimensionsScale = getSceneObjectScale(obstacle);
  const color = obstacle.color || (String(obstacle.id).startsWith('student-') ? '#8b5cf6' : '#f59e0b');
  const addMesh = (geometry, position) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color,
      emissive: 0x000000,
      roughness: 0.72,
      transparent: true,
      opacity: 0.82,
    }));
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.obstacleId = String(obstacle.id);
    mesh.userData.obstacleType = obstacle.type || 'unknown';
    group.add(mesh);
    return mesh;
  };

  switch (obstacle.type) {
    case 'box':
      addMesh(new THREE.BoxGeometry(size * 1.35, size * 1.35, size * 1.35), [0, size * 0.675, 0]);
      break;
    case 'wall':
      addMesh(new THREE.BoxGeometry(size * 2.4, size * 1.3, size * 0.48), [0, size * 0.65, 0]);
      break;
    case 'platform':
      addMesh(new THREE.BoxGeometry(size * 1.9, size * 0.28, size * 1.9), [0, size * 0.14, 0]);
      break;
    case 'ramp': {
      const ramp = new THREE.Shape();
      ramp.moveTo(-size, 0);
      ramp.lineTo(size, 0);
      ramp.lineTo(size, size * 1.25);
      ramp.closePath();
      const geometry = new THREE.ExtrudeGeometry(ramp, { depth: size * 1.4, bevelEnabled: false });
      geometry.translate(0, 0, -size * 0.7);
      addMesh(geometry, [0, 0, 0]);
      break;
    }
    case 'stairs':
      for (let step = 0; step < 3; step += 1) {
        const height = size * (step + 1) * 0.38;
        addMesh(
          new THREE.BoxGeometry(size * 0.72, height, size * 0.8),
          [(step - 1) * size * 0.56, height / 2, 0],
        );
      }
      break;
    case 'sphere':
      addMesh(new THREE.SphereGeometry(size * 0.7, 24, 16), [0, size * 0.7, 0]);
      break;
    case 'cylinder':
      addMesh(new THREE.CylinderGeometry(size * 0.62, size * 0.62, size * 1.3, 24), [0, size * 0.65, 0]);
      break;
    case 'table':
      addMesh(new THREE.BoxGeometry(size * 1.8, size * 0.18, size * 1.5), [0, size * 1.2, 0]);
      for (const xSign of [-1, 1]) {
        for (const zSign of [-1, 1]) {
          addMesh(new THREE.BoxGeometry(size * 0.14, size * 1.15, size * 0.14), [xSign * size * 0.72, size * 0.575, zSign * size * 0.58]);
        }
      }
      break;
    case 'terrain':
      addMesh(new THREE.IcosahedronGeometry(size, 1), [0, size * 0.28, 0]).scale.set(1.5, 0.55, 1.25);
      break;
    default:
      addMesh(new THREE.CylinderGeometry(size * 0.65, size * 0.75, size * 0.5, 24), [0, size * 0.25, 0]);
  }

  group.position.set(obstacle.x, 0, -obstacle.y);
  group.scale.set(dimensionsScale.x, dimensionsScale.y, dimensionsScale.z);
  group.userData.obstacleId = String(obstacle.id);
  group.userData.obstacleType = obstacle.type || 'unknown';
  return group;
}

function disposeObstacleMeshes(group) {
  group.traverse((object) => {
    object.geometry?.dispose();
    if (Array.isArray(object.material)) object.material.forEach((entry) => entry.dispose());
    else object.material?.dispose();
  });
}

function moveCameraTarget(view, horizontal, forward) {
  const right = new THREE.Vector3(Math.cos(view.yaw), 0, -Math.sin(view.yaw));
  const forwardDirection = new THREE.Vector3(Math.sin(view.yaw), 0, Math.cos(view.yaw));
  view.focusOffset.addScaledVector(right, horizontal);
  view.focusOffset.addScaledVector(forwardDirection, forward);
  view.target.addScaledVector(right, horizontal);
  view.target.addScaledVector(forwardDirection, forward);
}

function updateCameraPosition(camera, view) {
  if (!camera) return;
  camera.position.set(
    view.target.x + Math.sin(view.yaw) * Math.cos(view.pitch) * view.distance,
    view.target.y + Math.sin(view.pitch) * view.distance,
    view.target.z + Math.cos(view.yaw) * Math.cos(view.pitch) * view.distance,
  );
  camera.lookAt(view.target);
}

function addSegment(parent, start, end, width, color) {
  const startVector = new THREE.Vector3(...start);
  const endVector = new THREE.Vector3(...end);
  const direction = endVector.clone().sub(startVector);
  const length = direction.length();
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(width, Math.max(0.05, length - width * 2), 5, 10), material(color));
  mesh.position.copy(startVector.clone().add(endVector).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function createRobot() {
  const robot = new THREE.Group();
  robot.name = 'G1-23DoF';
  robot.scale.setScalar(0.45);
  const dark = 0x263241;
  const light = 0xd7e0e8;
  const accent = 0x19b5fe;
  const joints = {};
  const register = (name, parent, position = [0, 0, 0]) => {
    const group = new THREE.Group();
    group.name = name;
    group.position.set(...position);
    parent.add(group);
    joints[name] = group;
    return group;
  };

  const pelvis = register('pelvis', robot, [0, 1.65, 0]);
  addBox(pelvis, [0.72, 0.42, 0.42], [0, 0, 0], dark, 0);
  addBox(pelvis, [0.48, 0.12, 0.48], [0, 0.26, 0], light, 0);

  const waistYaw = register('waist_yaw_joint', pelvis, [0, 0.28, 0]);
  const torso = new THREE.Group();
  waistYaw.add(torso);
  addBox(torso, [0.62, 0.72, 0.38], [0, 0.38, 0], dark, 0);
  addBox(torso, [0.4, 0.3, 0.42], [0, 0.76, 0], light, 0);

  const head = register('head', torso, [0, 0.95, 0]);
  addBox(head, [0.4, 0.42, 0.38], [0, 0, 0], dark, 0);
  addBox(head, [0.22, 0.08, 0.04], [0, 0.02, -0.2], accent, 0);

  const leg = (side, x) => {
    const hipRoll = register(`${side}_hip_roll_joint`, pelvis, [x, -0.02, 0]);
    const hipYaw = register(`${side}_hip_yaw_joint`, hipRoll);
    const hipPitch = register(`${side}_hip_pitch_joint`, hipYaw);
    addSegment(hipPitch, [0, 0, 0], [0, -0.55, 0], 0.13, dark);
    const knee = register(`${side}_knee_joint`, hipPitch, [0, -0.55, 0]);
    addSegment(knee, [0, 0, 0], [0, -0.62, 0], 0.12, light);
    const anklePitch = register(`${side}_ankle_pitch_joint`, knee, [0, -0.62, 0]);
    const ankleRoll = register(`${side}_ankle_roll_joint`, anklePitch);
    addBox(ankleRoll, [0.24, 0.18, 0.42], [0, -0.12, -0.05], dark, 0);
    addBox(ankleRoll, [0.3, 0.1, 0.54], [0, -0.22, -0.1], light, 0);
  };
  leg('left', -0.24);
  leg('right', 0.24);

  const arm = (side, x) => {
    const shoulderPitch = register(`${side}_shoulder_pitch_joint`, torso, [x, 0.68, 0]);
    const shoulderRoll = register(`${side}_shoulder_roll_joint`, shoulderPitch);
    const shoulderYaw = register(`${side}_shoulder_yaw_joint`, shoulderRoll);
    addSegment(shoulderYaw, [0, 0, 0], [0, -0.48, 0], 0.1, light);
    const elbow = register(`${side}_elbow_joint`, shoulderYaw, [0, -0.48, 0]);
    addSegment(elbow, [0, 0, 0], [0, -0.46, 0], 0.085, dark);
    const wristRoll = register(`${side}_wrist_roll_joint`, elbow, [0, -0.46, 0]);
    addBox(wristRoll, [0.16, 0.2, 0.2], [0, -0.1, 0], light, 0);
  };
  arm('left', -0.46);
  arm('right', 0.46);

  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.012, 8, 64), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.7 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -1.64;
  robot.add(ring);
  return { robot, joints };
}

const MUJOCO_TO_VIEW = new THREE.Matrix4().set(
  0, 1, 0, 0,
  0, 0, 1, 0,
  1, 0, 0, 0,
  0, 0, 0, 1,
);

function parseFloatVector(value, fallback = [0, 0, 0]) {
  return value ? value.trim().split(/\s+/).map(Number) : fallback;
}

function quatFromWxyz(value) {
  const [w, x, y, z] = parseFloatVector(value, [1, 0, 0, 0]);
  return new THREE.Quaternion(x, y, z, w);
}

function convertPosition(position) {
  return new THREE.Vector3(...parseFloatVector(position)).applyMatrix4(MUJOCO_TO_VIEW);
}

function convertQuaternion(quaternion) {
  const rotation = new THREE.Matrix4().makeRotationFromQuaternion(quatFromWxyz(quaternion));
  const converted = MUJOCO_TO_VIEW.clone().multiply(rotation).multiply(MUJOCO_TO_VIEW.clone().invert());
  return new THREE.Quaternion().setFromRotationMatrix(converted);
}

function createWaypointLabelTexture(label) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, 128, 128);
  context.beginPath();
  context.arc(64, 64, 56, 0, Math.PI * 2);
  context.fillStyle = '#0284c7';
  context.fill();
  context.lineWidth = 8;
  context.strokeStyle = '#bae6fd';
  context.stroke();
  context.fillStyle = '#f8fafc';
  context.font = 'bold 66px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(String(label), 64, 67);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createWaypointDistanceTexture(distance) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 80;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.beginPath();
  context.roundRect(8, 8, 240, 64, 24);
  context.fillStyle = 'rgba(15, 23, 42, 0.88)';
  context.fill();
  context.lineWidth = 4;
  context.strokeStyle = '#38bdf8';
  context.stroke();
  context.fillStyle = '#f8fafc';
  context.font = 'bold 38px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(`${distance.toFixed(2)} m`, 128, 42);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createWaypointMarker(id, index) {
  const marker = new THREE.Group();
  marker.userData.waypointId = id;
  marker.userData.index = index;

  const hitTarget = new THREE.Mesh(
    new THREE.CylinderGeometry(0.36, 0.36, 0.24, 24),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthWrite: false }),
  );
  hitTarget.position.y = 0.12;
  hitTarget.userData.waypointId = id;
  marker.add(hitTarget);

  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(0.19, 0.19, 0.09, 32),
    new THREE.MeshStandardMaterial({ color: 0x0ea5e9, emissive: 0x075985, roughness: 0.35, metalness: 0.2 }),
  );
  pad.position.y = 0.08;
  pad.userData.waypointId = id;
  marker.add(pad);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.23, 0.29, 40),
    new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.82, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.025;
  ring.userData.waypointId = id;
  marker.add(ring);

  const labelMaterial = new THREE.SpriteMaterial({ map: createWaypointLabelTexture(index + 1), transparent: true, depthTest: false });
  const label = new THREE.Sprite(labelMaterial);
  label.scale.set(0.31, 0.31, 1);
  label.position.y = 0.34;
  label.renderOrder = 4;
  marker.add(label);

  marker.userData.pad = pad;
  marker.userData.ring = ring;
  marker.userData.label = label;
  return marker;
}

function disposeWaypointMarker(marker) {
  marker.traverse((object) => {
    object.geometry?.dispose();
    if (object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((entry) => {
        entry.map?.dispose();
        entry.dispose();
      });
    }
  });
}

function syncWaypointMarkers(group, pathLine, waypoints) {
  if (!group) return;
  const existing = new Map(group.children
    .filter((marker) => marker.userData.waypointId !== undefined)
    .map((marker) => [marker.userData.waypointId, marker]));
  const activeIds = new Set();

  waypoints.forEach((waypoint, index) => {
    const id = String(waypoint.id);
    activeIds.add(id);
    let marker = existing.get(id);
    if (!marker) {
      marker = createWaypointMarker(id, index);
      group.add(marker);
    }
    marker.position.set(Number(waypoint.x) || 0, 0, -(Number(waypoint.y) || 0));
    if (marker.userData.index !== index) {
      marker.userData.label.material.map.dispose();
      marker.userData.label.material.map = createWaypointLabelTexture(index + 1);
      marker.userData.index = index;
    }
  });

  [...group.children].forEach((marker) => {
    if (marker.userData.waypointId === undefined) {
      group.remove(marker);
      disposeWaypointMarker(marker);
      return;
    }
    if (activeIds.has(marker.userData.waypointId)) return;
    group.remove(marker);
    disposeWaypointMarker(marker);
  });

  waypoints.slice(1).forEach((waypoint, index) => {
    const previous = waypoints[index];
    const distance = Math.hypot(
      (Number(waypoint.x) || 0) - (Number(previous.x) || 0),
      (Number(waypoint.y) || 0) - (Number(previous.y) || 0),
    );
    const label = new THREE.Sprite(new THREE.SpriteMaterial({
      map: createWaypointDistanceTexture(distance),
      transparent: true,
      depthTest: false,
    }));
    label.scale.set(0.95, 0.3, 1);
    label.position.set(
      ((Number(previous.x) || 0) + (Number(waypoint.x) || 0)) / 2,
      0.22,
      -((Number(previous.y) || 0) + (Number(waypoint.y) || 0)) / 2,
    );
    label.renderOrder = 5;
    group.add(label);
  });

  if (pathLine) {
    pathLine.geometry.setFromPoints(waypoints.map((waypoint) => new THREE.Vector3(Number(waypoint.x) || 0, 0.045, -(Number(waypoint.y) || 0))));
    pathLine.visible = waypoints.length > 1;
  }
}

function setWaypointMarkerDragging(marker, isDragging) {
  if (!marker) return;
  marker.scale.setScalar(isDragging ? 1.18 : 1);
  marker.userData.pad.material.emissive.set(isDragging ? 0x22d3ee : 0x075985);
  marker.userData.ring.material.color.set(isDragging ? 0xa5f3fc : 0x22d3ee);
  marker.userData.ring.material.opacity = isDragging ? 1 : 0.82;
}

async function loadG1MeshRig() {
  const xmlText = await fetch('/g1/g1.xml').then((response) => {
    if (!response.ok) throw new Error(`G1 rig unavailable (${response.status})`);
    return response.text();
  });
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  const meshFiles = new Map([...xml.querySelectorAll('asset > mesh')].map((mesh) => [mesh.getAttribute('name'), mesh.getAttribute('file')]));
  const loader = new STLLoader();
  const geometryCache = new Map();
  const materialCache = new Map();
  const activeJointNames = new Set(G1_EDU_23_ENV.joints);
  if (activeJointNames.size !== 23) {
    throw new Error(`Expected 23 active G1 joints, found ${activeJointNames.size}`);
  }
  const rigJointNames = new Set([...xml.querySelectorAll('joint[name]')].map((joint) => joint.getAttribute('name')));
  const missingJointNames = [...activeJointNames].filter((name) => !rigJointNames.has(name));
  if (missingJointNames.length) {
    throw new Error(`G1 mesh rig is missing active joints: ${missingJointNames.join(', ')}`);
  }
  const jointClassAxes = new Map([...xml.querySelectorAll('default')].flatMap((element) => {
    const className = element.getAttribute('class');
    const axis = element.querySelector(':scope > joint')?.getAttribute('axis');
    return className && axis ? [[className, axis]] : [];
  }));
  const jointClassRanges = new Map([...xml.querySelectorAll('default')].flatMap((element) => {
    const className = element.getAttribute('class');
    const range = element.querySelector(':scope > joint')?.getAttribute('range');
    return className && range ? [[className, range]] : [];
  }));
  const rootBody = xml.querySelector('worldbody > body');
  const robot = new THREE.Group();
  robot.name = 'G1-34Link-MeshRig';
  const joints = {};

  const loadGeometry = async (meshName) => {
    if (!geometryCache.has(meshName)) {
      const file = meshFiles.get(meshName);
      if (!file) return null;
      const geometry = await loader.loadAsync(`/g1/meshes/${file}`);
      geometry.applyMatrix4(MUJOCO_TO_VIEW);
      geometry.computeVertexNormals();
      geometryCache.set(meshName, geometry);
    }
    return geometryCache.get(meshName);
  };

  const getMaterial = (meshName) => {
    const dark = /pelvis|hip|knee|waist|torso|head|logo|elbow|hand/.test(meshName);
    const key = dark ? 'dark' : 'light';
    if (!materialCache.has(key)) {
      materialCache.set(key, new THREE.MeshStandardMaterial({
        color: dark ? 0x263241 : 0xcbd5e1,
        metalness: 0.5,
        roughness: 0.36,
      }));
    }
    return materialCache.get(key);
  };

  const visitBody = async (bodyElement, parent) => {
    const body = new THREE.Group();
    body.name = bodyElement.getAttribute('name') || 'g1-link';
    body.position.copy(convertPosition(bodyElement.getAttribute('pos')));
    body.quaternion.copy(convertQuaternion(bodyElement.getAttribute('quat')));
    body.userData.baseQuaternion = body.quaternion.clone();
    parent.add(body);

    const joint = bodyElement.querySelector(':scope > joint');
    if (activeJointNames.has(joint?.getAttribute('name'))) {
      const jointName = joint.getAttribute('name');
      const axis = joint.getAttribute('axis') || jointClassAxes.get(joint.getAttribute('class'));
      joints[jointName] = body;
      body.userData.rotationAxis = convertMujocoAxisToView(axis);
      body.userData.jointRange = joint.getAttribute('range') || jointClassRanges.get(joint.getAttribute('class'));
    }

    const geomElements = [...bodyElement.querySelectorAll(':scope > geom[mesh]')];
    await Promise.all(geomElements.map(async (geom) => {
      const meshName = geom.getAttribute('mesh');
      const geometry = await loadGeometry(meshName);
      if (!geometry) return;
      const mesh = new THREE.Mesh(geometry, getMaterial(meshName));
      mesh.name = meshName;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.copy(convertPosition(geom.getAttribute('pos')));
      mesh.quaternion.copy(convertQuaternion(geom.getAttribute('quat')));
      body.add(mesh);
    }));

    for (const child of bodyElement.querySelectorAll(':scope > body')) {
      await visitBody(child, body);
    }
  };

  await visitBody(rootBody, robot);
  return { robot, joints };
}

export default function G1Simulation3D({ code, simulatorState, controllerVersion = 'legacy', recordedMotionPreview = null, obstacles = [], waypoints = [], onObstacleChange, onObstacleSelect, onWaypointChange, isWaypointPlacementEnabled = false, onWaypointPlace, isPlaying = false, playbackSpeed = 1, playbackProgress = 0, gridSize = 20, onPlaybackProgress, onPlaybackToggle, onPlaybackReset, onPlaybackSpeedChange, workspacePanelRef }) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const rendererRef = useRef(null);
  const framesRef = useRef([]);
  const cameraRef = useRef(null);
  const robotRef = useRef(null);
  const robotHeadingOffsetRef = useRef(-90);
  const jointRefs = useRef({});
  const obstacleGroupRef = useRef(null);
  const waypointGroupRef = useRef(null);
  const plannerLineRef = useRef(null);
  const waypointsRef = useRef(waypoints);
  const obstacleChangeCallbackRef = useRef(onObstacleChange);
  const obstacleSelectCallbackRef = useRef(onObstacleSelect);
  const waypointChangeCallbackRef = useRef(onWaypointChange);
  const waypointPlaceCallbackRef = useRef(onWaypointPlace);
  const waypointPlacementEnabledRef = useRef(isWaypointPlacementEnabled);
  const draggingMarkerRef = useRef(null);
  const simulatorStateRef = useRef(simulatorState);
  const viewRef = useRef({
    yaw: DEFAULT_CAMERA_YAW,
    pitch: DEFAULT_CAMERA_PITCH,
    distance: DEFAULT_CAMERA_DISTANCE,
    target: new THREE.Vector3(0, DEFAULT_CAMERA_TARGET_HEIGHT, 0),
    focusOffset: new THREE.Vector3(0, 0, 0),
    pointers: new Map(),
    pinchDistance: 0,
    pinchMidpoint: null,
  });
  const defaultHorizontalFocusRef = useRef(null);
  const isPlayingRef = useRef(isPlaying);
  const playbackSpeedRef = useRef(playbackSpeed);
  const playbackProgressRef = useRef(playbackProgress);
  const playbackProgressCallbackRef = useRef(onPlaybackProgress);
  const playbackToggleCallbackRef = useRef(onPlaybackToggle);
  const [isPlaybackBarOpen, setIsPlaybackBarOpen] = useState(true);
  const [renderError, setRenderError] = useState('');
  const [cameraPadPosition, setCameraPadPosition] = useState(null);
  const cameraPadPositionRef = useRef(cameraPadPosition);
  const [isCameraPadCollapsed, setIsCameraPadCollapsed] = useState(false);
  const cameraPadDragRef = useRef(null);
  const cameraPadRef = useRef(null);

  useEffect(() => {
    cameraPadPositionRef.current = cameraPadPosition;
  }, [cameraPadPosition]);

  const beginCameraPadDrag = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const bounds = cameraPadRef.current?.getBoundingClientRect();
    if (!bounds) return;
    cameraPadDragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveCameraPad = (event) => {
    const drag = cameraPadDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = cameraPadRef.current?.getBoundingClientRect();
    const mountBounds = mountRef.current?.getBoundingClientRect();
    if (!bounds || !mountBounds) return;
    setCameraPadPosition({
      left: THREE.MathUtils.clamp(
        event.clientX - drag.offsetX - mountBounds.left,
        8,
        Math.max(8, mountBounds.width - bounds.width - 8),
      ),
      top: THREE.MathUtils.clamp(
        event.clientY - drag.offsetY - mountBounds.top,
        8,
        Math.max(8, mountBounds.height - bounds.height - 8),
      ),
    });
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    const keepCameraPadInView = () => {
      const padBounds = cameraPadRef.current?.getBoundingClientRect();
      if (!padBounds || !cameraPadPositionRef.current) return;
      setCameraPadPosition((position) => {
        if (!position) return position;
        return {
          left: THREE.MathUtils.clamp(position.left, 8, Math.max(8, mount.clientWidth - padBounds.width - 8)),
          top: THREE.MathUtils.clamp(position.top, 8, Math.max(8, mount.clientHeight - padBounds.height - 8)),
        };
      });
    };
    const observer = new ResizeObserver(keepCameraPadInView);
    observer.observe(mount);
    return () => observer.disconnect();
  }, []);

  const endCameraPadDrag = (event) => {
    if (cameraPadDragRef.current?.pointerId === event.pointerId) {
      cameraPadDragRef.current = null;
    }
  };

  const panView = (horizontal, forward) => {
    const view = viewRef.current;
    const step = view.distance * 0.12;
    const offset = getCameraPanTargetOffset(horizontal, forward, step);
    moveCameraTarget(view, offset.horizontal, offset.forward);
    updateCameraPosition(cameraRef.current, view);
  };

  const zoomView = (factor) => {
    const view = viewRef.current;
    view.distance = THREE.MathUtils.clamp(view.distance * factor, 2.5, 30);
    updateCameraPosition(cameraRef.current, view);
  };

  const resetView = () => {
    const view = viewRef.current;
    view.yaw = DEFAULT_CAMERA_YAW;
    view.pitch = DEFAULT_CAMERA_PITCH;
    view.distance = DEFAULT_CAMERA_DISTANCE;
    const horizontalFocus = defaultHorizontalFocusRef.current || 0;
    view.focusOffset.set(horizontalFocus, 0, 0);
    view.target.set(horizontalFocus, DEFAULT_CAMERA_TARGET_HEIGHT, 0);
    updateCameraPosition(cameraRef.current, view);
  };

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    playbackSpeedRef.current = playbackSpeed;
  }, [playbackSpeed]);

  useEffect(() => {
    playbackProgressRef.current = playbackProgress;
  }, [playbackProgress]);

  useEffect(() => {
    playbackProgressCallbackRef.current = onPlaybackProgress;
    playbackToggleCallbackRef.current = onPlaybackToggle;
  }, [onPlaybackProgress, onPlaybackToggle]);

  useEffect(() => {
    simulatorStateRef.current = simulatorState;
  }, [simulatorState]);

  useEffect(() => {
    waypointsRef.current = waypoints;
    obstacleChangeCallbackRef.current = onObstacleChange;
    obstacleSelectCallbackRef.current = onObstacleSelect;
    waypointChangeCallbackRef.current = onWaypointChange;
    waypointPlaceCallbackRef.current = onWaypointPlace;
    waypointPlacementEnabledRef.current = isWaypointPlacementEnabled;
    if (rendererRef.current) {
      rendererRef.current.domElement.style.cursor = isWaypointPlacementEnabled ? 'crosshair' : '';
    }
  }, [waypoints, onObstacleChange, onObstacleSelect, onWaypointChange, isWaypointPlacementEnabled, onWaypointPlace]);

  useEffect(() => {
    if (!waypoints.length) return;

    const points = [{ x: 0, y: 0 }, ...waypoints];
    const bounds = points.reduce((current, point) => ({
      minX: Math.min(current.minX, Number(point.x) || 0),
      maxX: Math.max(current.maxX, Number(point.x) || 0),
      minY: Math.min(current.minY, Number(point.y) || 0),
      maxY: Math.max(current.maxY, Number(point.y) || 0),
    }), { minX: 0, maxX: 0, minY: 0, maxY: 0 });
    const view = viewRef.current;
    const camera = cameraRef.current;
    const radius = Math.max(
      Math.hypot(bounds.minX, bounds.minY),
      Math.hypot(bounds.minX, bounds.maxY),
      Math.hypot(bounds.maxX, bounds.minY),
      Math.hypot(bounds.maxX, bounds.maxY),
    );
    const verticalFov = THREE.MathUtils.degToRad(camera?.fov ?? 42);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * (camera?.aspect ?? 1));
    const requiredDistance = Math.max(
      radius / Math.tan(horizontalFov / 2),
      (radius * Math.sin(view.pitch) + 1.8) / Math.tan(verticalFov / 2),
    ) * 1.15;

    view.target.set(
      view.focusOffset.x,
      DEFAULT_CAMERA_TARGET_HEIGHT + view.focusOffset.y,
      view.focusOffset.z,
    );
    view.distance = Math.max(DEFAULT_CAMERA_DISTANCE, requiredDistance);
  }, [waypoints]);

  useEffect(() => {
    framesRef.current = recordedMotionPreview
      ? buildG1RecordedArmMotionFrames(recordedMotionPreview)
      : controllerVersion === 'duet'
        ? simulateDuetG1Edu23Program(code)
        : buildG1SimulationFrames(code, {
          obstacles,
          challenge: simulatorState?.goal ? { goal: simulatorState.goal } : null,
        });
  }, [code, controllerVersion, obstacles, recordedMotionPreview, simulatorState?.goal]);

  useEffect(() => {
    const group = obstacleGroupRef.current;
    if (!group) return;
    group.children.forEach(disposeObstacleMeshes);
    group.clear();
    obstacles.forEach((obstacle) => {
      group.add(createObstacleMesh(obstacle));
    });
  }, [obstacles]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x08111d);
    scene.fog = new THREE.Fog(0x08111d, 11, 28);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    cameraRef.current = camera;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (error) {
      console.error('G1 3D simulation could not initialize WebGL.', error);
      window.setTimeout(() => {
        setRenderError('The 3D simulator could not start because WebGL is unavailable or disabled in this browser. You can still use the programming tools, but 3D simulation is unavailable.');
      }, 0);
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.style.cursor = waypointPlacementEnabledRef.current ? 'crosshair' : '';
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute(
      'aria-label',
      '3D simulation. Use arrow keys or W A S D to pan, Q and E to rotate, plus and minus to zoom.',
    );
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    sceneRef.current = scene;

    scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x152234, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(4, 8, 5);
    key.castShadow = true;
    scene.add(key);
    const rim = new THREE.PointLight(0x22d3ee, 16, 12);
    rim.position.set(-4, 3, -3);
    scene.add(rim);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(gridSize, gridSize), new THREE.MeshStandardMaterial({ color: 0x101c29, roughness: 0.85, metalness: 0.1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(gridSize, Math.max(1, Math.round(gridSize)), 0x67c9ed, 0x49677f);
    grid.position.y = 0.012;
    grid.material.transparent = true;
    grid.material.opacity = 0.9;
    grid.material.depthWrite = false;
    scene.add(grid);
    const majorGrid = new THREE.GridHelper(gridSize, Math.max(1, Math.round(gridSize / 5)), 0xa5e6ff, 0x7197ad);
    majorGrid.position.y = 0.018;
    majorGrid.material.transparent = true;
    majorGrid.material.opacity = 0.62;
    majorGrid.material.depthWrite = false;
    scene.add(majorGrid);

    const goal = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.76, 48), new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    goal.rotation.x = -Math.PI / 2;
    goal.position.y = 0.03;
    scene.add(goal);

    const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.6 }));
    scene.add(pathLine);

    const waypointGroup = new THREE.Group();
    waypointGroupRef.current = waypointGroup;
    scene.add(waypointGroup);
    const plannerLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.92 }),
    );
    plannerLine.visible = false;
    plannerLineRef.current = plannerLine;
    scene.add(plannerLine);
    syncWaypointMarkers(waypointGroup, plannerLine, waypointsRef.current);

    const obstacleGroup = new THREE.Group();
    obstacleGroupRef.current = obstacleGroup;
    scene.add(obstacleGroup);
    obstacles.forEach((obstacle) => {
      obstacleGroup.add(createObstacleMesh(obstacle));
    });

    const built = createRobot();
    robotRef.current = built.robot;
    jointRefs.current = built.joints;
    scene.add(built.robot);
    let disposed = false;
    loadG1MeshRig().then((loaded) => {
      if (disposed) {
        loaded.robot.traverse((object) => {
          if (object.geometry) object.geometry.dispose();
        });
        return;
      }
      scene.remove(built.robot);
      built.robot.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) object.material.dispose();
      });
      robotRef.current = loaded.robot;
      robotHeadingOffsetRef.current = 90;
      jointRefs.current = loaded.joints;
      scene.add(loaded.robot);
    }).catch((error) => {
      console.warn('G1 mesh rig unavailable; using procedural fallback.', error);
    });

    const resize = () => {
      const width = mount.clientWidth || 1;
      const height = mount.clientHeight || 1;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    resize();
    if (defaultHorizontalFocusRef.current === null) {
      const mountBounds = mount.getBoundingClientRect();
      const panelBounds = workspacePanelRef?.current?.getBoundingClientRect();
      const panelOverlapsView = panelBounds
        && panelBounds.left < mountBounds.right
        && panelBounds.right > mountBounds.left
        && panelBounds.top < mountBounds.bottom
        && panelBounds.bottom > mountBounds.top;
      const visibleWidth = panelOverlapsView
        ? Math.max(0, Math.min(mount.clientWidth, panelBounds.left - mountBounds.left))
        : mount.clientWidth;
      defaultHorizontalFocusRef.current = getCameraHorizontalFocusOffset(
        mount.clientWidth,
        visibleWidth,
        DEFAULT_CAMERA_DISTANCE,
        camera.aspect,
        camera.fov,
      );
      viewRef.current.focusOffset.set(defaultHorizontalFocusRef.current, 0, 0);
      viewRef.current.target.set(defaultHorizontalFocusRef.current, DEFAULT_CAMERA_TARGET_HEIGHT, 0);
    }
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    const updateCamera = () => {
      updateCameraPosition(camera, viewRef.current);
    };
    updateCamera();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let lastPointerClick = null;
    const readPointer = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    };
    const setObstacleHighlight = (obstacleId, isDragging) => {
      const group = obstacleGroup.children.find((obstacle) => obstacle.userData.obstacleId === obstacleId);
      group?.traverse((object) => {
        if (object.material?.emissive) object.material.emissive.set(isDragging ? 0x22d3ee : 0x000000);
      });
    };
    const onPointerDown = (event) => {
      renderer.domElement.focus({ preventScroll: true });
      readPointer(event);
      const now = performance.now();
      const isDoubleClickDrag = event.pointerType === 'mouse'
        && event.button === 0
        && lastPointerClick
        && now - lastPointerClick.time < 350
        && Math.hypot(event.clientX - lastPointerClick.x, event.clientY - lastPointerClick.y) < 24;
      if (isDoubleClickDrag) lastPointerClick = null;
      const mousePan = event.pointerType === 'mouse'
        && (event.button === 1 || event.button === 2 || event.shiftKey || isDoubleClickDrag);
      if (waypointPlacementEnabledRef.current && !mousePan) {
        const worldPosition = raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
        const halfGrid = gridSize / 2;
        if (
          worldPosition
          && Math.abs(worldPosition.x) <= halfGrid
          && Math.abs(worldPosition.z) <= halfGrid
        ) {
          waypointPlaceCallbackRef.current?.({
            x: Number(worldPosition.x.toFixed(2)),
            y: Number((-worldPosition.z).toFixed(2)),
          });
        }
        event.preventDefault();
        return;
      }
      const waypointHit = mousePan ? null : raycaster.intersectObjects(waypointGroup.children, true)
        .find((hit) => hit.object.userData.waypointId !== undefined);
      if (waypointHit) {
        const waypointId = waypointHit.object.userData.waypointId;
        const marker = waypointGroup.children.find((item) => item.userData.waypointId === waypointId);
        draggingMarkerRef.current = { kind: 'waypoint', id: waypointId, pointerId: event.pointerId };
        setWaypointMarkerDragging(marker, true);
        renderer.domElement.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
      const obstacleHit = mousePan ? null : raycaster.intersectObjects(obstacleGroup.children, true)
        .find((hit) => hit.object.userData.obstacleId !== undefined);
      if (obstacleHit) {
        const obstacleId = obstacleHit.object.userData.obstacleId;
        obstacleSelectCallbackRef.current?.(obstacleId);
        draggingMarkerRef.current = { kind: 'obstacle', id: obstacleId, pointerId: event.pointerId };
        setObstacleHighlight(obstacleId, true);
        renderer.domElement.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
      const view = viewRef.current;
      view.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        mode: mousePan ? 'pan' : 'rotate',
        moved: false,
      });
      renderer.domElement.setPointerCapture?.(event.pointerId);
      if (mousePan) event.preventDefault();
      if (view.pointers.size === 2) {
        const points = [...view.pointers.values()];
        view.pinchDistance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
        view.pinchMidpoint = {
          x: (points[0].x + points[1].x) / 2,
          y: (points[0].y + points[1].y) / 2,
        };
      }
    };
    const onPointerMove = (event) => {
      const draggingMarker = draggingMarkerRef.current;
      if (draggingMarker?.pointerId === event.pointerId) {
        readPointer(event);
        const worldPosition = raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
        if (!worldPosition) return;
        const halfGrid = gridSize / 2;
        const x = Number(THREE.MathUtils.clamp(worldPosition.x, -halfGrid, halfGrid).toFixed(2));
        const y = Number(THREE.MathUtils.clamp(-worldPosition.z, -halfGrid, halfGrid).toFixed(2));
        if (draggingMarker.kind === 'waypoint') {
          const marker = waypointGroup.children.find((item) => item.userData.waypointId === draggingMarker.id);
          if (marker) marker.position.set(x, 0, -y);
          waypointChangeCallbackRef.current?.(draggingMarker.id, { x, y });
        } else {
          const obstacle = obstacleGroup.children.find((item) => item.userData.obstacleId === draggingMarker.id);
          if (obstacle) obstacle.position.set(x, 0, -y);
          obstacleChangeCallbackRef.current?.(draggingMarker.id, { x, y });
        }
        return;
      }
      const view = viewRef.current;
      if (!view.pointers.has(event.pointerId)) return;
      const previous = view.pointers.get(event.pointerId);
      view.pointers.set(event.pointerId, {
        ...previous,
        x: event.clientX,
        y: event.clientY,
        moved: previous.moved || Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > 3,
      });

      if (view.pointers.size >= 2) {
        const points = [...view.pointers.values()];
        const midpoint = {
          x: (points[0].x + points[1].x) / 2,
          y: (points[0].y + points[1].y) / 2,
        };
        const pinchDistance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
        const width = renderer.domElement.clientWidth || 1;
        const zoomRatio = view.pinchDistance ? view.pinchDistance / Math.max(1, pinchDistance) : 1;
        view.distance = Math.max(3.4, Math.min(12, view.distance * zoomRatio));
        if (view.pinchMidpoint) {
          const deltaX = midpoint.x - view.pinchMidpoint.x;
          const deltaY = midpoint.y - view.pinchMidpoint.y;
          const panScale = view.distance / width;
          const right = new THREE.Vector3(Math.cos(view.yaw), 0, -Math.sin(view.yaw));
          const forward = new THREE.Vector3(Math.sin(view.yaw), 0, Math.cos(view.yaw));
          view.focusOffset.addScaledVector(right, -deltaX * panScale * 0.9);
          view.focusOffset.addScaledVector(forward, deltaY * panScale * 0.9);
          view.target.addScaledVector(right, -deltaX * panScale * 0.9);
          view.target.addScaledVector(forward, deltaY * panScale * 0.9);
        }
        view.pinchDistance = pinchDistance;
        view.pinchMidpoint = midpoint;
      } else {
        const deltaX = event.clientX - previous.x;
        const deltaY = event.clientY - previous.y;
        if (previous.mode === 'pan') {
          const panScale = view.distance / (renderer.domElement.clientHeight || 1) * 0.9;
          moveCameraTarget(view, -deltaX * panScale, deltaY * panScale);
        } else {
          view.yaw -= deltaX * 0.008;
          view.pitch = Math.max(0.2, Math.min(1.35, view.pitch - deltaY * 0.006));
        }
      }
      updateCamera();
    };
    const onPointerUp = (event) => {
      const draggingMarker = draggingMarkerRef.current;
      if (draggingMarker?.pointerId === event.pointerId) {
        if (draggingMarker.kind === 'waypoint') {
          const marker = waypointGroup.children.find((item) => item.userData.waypointId === draggingMarker.id);
          setWaypointMarkerDragging(marker, false);
        } else {
          setObstacleHighlight(draggingMarker.id, false);
        }
        draggingMarkerRef.current = null;
        return;
      }
      const view = viewRef.current;
      const pointerState = view.pointers.get(event.pointerId);
      view.pointers.delete(event.pointerId);
      if (event.pointerType === 'mouse' && event.button === 0 && pointerState && !pointerState.moved) {
        lastPointerClick = { time: performance.now(), x: event.clientX, y: event.clientY };
      }
      if (view.pointers.size < 2) {
        view.pinchDistance = 0;
        view.pinchMidpoint = null;
      }
    };
    const onWheel = (event) => {
      event.preventDefault();
      const zoomFactor = Math.exp(event.deltaY * 0.0012);
      viewRef.current.distance = Math.max(2.5, Math.min(30, viewRef.current.distance * zoomFactor));
      updateCamera();
    };
    const onKeyDown = (event) => {
      const activeElement = document.activeElement;
      if (
        !mount.contains(activeElement)
        || activeElement?.matches('input, textarea, select, [contenteditable="true"]')
      ) return;
      const pan = getCameraPanDirection(event.key);
      const view = viewRef.current;
      if (pan) {
        event.preventDefault();
        const step = view.distance * 0.12;
        moveCameraTarget(view, pan[0] * step, pan[1] * step);
        updateCamera();
        return;
      }
      if (event.key.toLowerCase() === 'q' || event.key.toLowerCase() === 'e') {
        event.preventDefault();
        view.yaw += event.key.toLowerCase() === 'q' ? -0.12 : 0.12;
        updateCamera();
        return;
      }
      if (event.key === '+' || event.key === '=' || event.key === '-') {
        event.preventDefault();
        view.distance = THREE.MathUtils.clamp(view.distance * (event.key === '-' ? 1.12 : 0.89), 2.5, 30);
        updateCamera();
      }
    };
    const onContextMenu = (event) => event.preventDefault();
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    mount.addEventListener('keydown', onKeyDown);
    renderer.domElement.addEventListener('contextmenu', onContextMenu);

    const clock = new THREE.Clock();
    const onWebGLContextLost = (event) => {
      event.preventDefault();
      setRenderError('The browser lost its WebGL graphics context. Reload the page or enable hardware acceleration to restore the 3D simulator.');
    };
    renderer.domElement.addEventListener('webglcontextlost', onWebGLContextLost, false);
    const animate = () => {
      if (renderer.getContext().isContextLost()) {
        setRenderError('The browser lost its WebGL graphics context. Reload the page or enable hardware acceleration to restore the 3D simulator.');
        return;
      }
      const delta = clock.getDelta();
      const frames = framesRef.current;
      let frame = frames[frames.length - 1] || simulatorStateRef.current;
      if (frames.length) {
        const totalDuration = Math.max(0, frames[frames.length - 1].time || 0);
        if (frames.length > 1 && totalDuration > 0 && isPlayingRef.current) {
          playbackProgressRef.current = Math.min(
            1,
            playbackProgressRef.current + (delta * playbackSpeedRef.current) / totalDuration,
          );
          playbackProgressCallbackRef.current?.(playbackProgressRef.current);
          if (playbackProgressRef.current >= 1) playbackToggleCallbackRef.current?.(false);
        }
        const targetTime = playbackProgressRef.current * totalDuration;
        let first = 0;
        let last = frames.length - 1;
        while (first < last) {
          const middle = Math.ceil((first + last) / 2);
          if ((frames[middle].time || 0) <= targetTime) first = middle;
          else last = middle - 1;
        }
        const frameIndex = first;
        const nextIndex = Math.min(frames.length - 1, frameIndex + 1);
        const frameStartTime = frames[frameIndex].time || 0;
        const frameEndTime = frames[nextIndex].time || frameStartTime;
        const frameDuration = frameEndTime - frameStartTime;
        const frameProgress = frameDuration > 0 ? (targetTime - frameStartTime) / frameDuration : 0;
        frame = interpolateSimulationFrame(frames[frameIndex], frames[nextIndex], frameProgress);
      }
      if (robotRef.current && frame) {
        robotRef.current.position.x = frame.x || 0;
        robotRef.current.position.z = -(frame.y || 0);
        robotRef.current.rotation.y = THREE.MathUtils.degToRad((frame.heading || 0) + robotHeadingOffsetRef.current);
        Object.entries(jointRefs.current).forEach(([name, group]) => {
          const normalizedName = name.replace('_joint', '');
          const value = clampMujocoJointAngle(
            getMujocoJointAngle(frame.joints, name),
            group.userData.jointRange,
          );
          const meshAxis = group.userData.rotationAxis;
          if (meshAxis) {
            group.quaternion.copy(composeMujocoJointQuaternion(
              group.userData.baseQuaternion,
              meshAxis,
              THREE.MathUtils.degToRad(value),
            ));
          } else {
            const axis = JOINT_AXES[normalizedName] || (normalizedName.includes('pitch') ? 'x' : 'y');
            group.rotation[axis] = THREE.MathUtils.degToRad(value);
          }
        });
        const path = frame.path || [];
        pathLine.geometry.setFromPoints(path.map((point) => new THREE.Vector3(point.x, 0.035, -point.y)));
        if (frame.goal) {
          goal.visible = true;
          goal.position.set(frame.goal.x, 0.03, -frame.goal.y);
        } else {
          goal.visible = false;
        }
        updateCamera();
      }
      try {
        renderer.render(scene, camera);
      } catch (error) {
        console.error('G1 3D simulation rendering failed.', error);
        setRenderError('The 3D simulator encountered a graphics error. Reload the page or enable hardware acceleration to restore it.');
        return;
      }
      animationFrame = requestAnimationFrame(animate);
    };
    let animationFrame = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('pointerleave', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      mount.removeEventListener('keydown', onKeyDown);
      renderer.domElement.removeEventListener('contextmenu', onContextMenu);
      renderer.domElement.removeEventListener('webglcontextlost', onWebGLContextLost);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      rendererRef.current = null;
      waypointGroup.children.forEach(disposeWaypointMarker);
      plannerLine.geometry.dispose();
      plannerLine.material.dispose();
      waypointGroupRef.current = null;
      plannerLineRef.current = null;
      obstacleGroupRef.current = null;
    };
  }, [gridSize, obstacles, workspacePanelRef]);

  useEffect(() => {
    syncWaypointMarkers(waypointGroupRef.current, plannerLineRef.current, waypoints);
  }, [waypoints]);

  return (
    <div ref={mountRef} className="absolute inset-0 overflow-hidden touch-none" aria-label={`Live ${G1_EDU_23_ENV.robotType} 3D simulation`}>
      {renderError && (
        <div role="alert" className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/95 p-6 text-center">
          <div className="max-w-lg rounded-xl border border-amber-300/30 bg-slate-900 p-6 text-slate-100 shadow-xl">
            <h2 className="text-lg font-semibold text-amber-200">3D simulation unavailable</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">{renderError}</p>
          </div>
        </div>
      )}
      <div className="pointer-events-none absolute left-3 top-3 max-w-[calc(100%-5.5rem)] rounded-lg border border-cyan-300/20 bg-slate-950/65 px-3 py-2 text-cyan-100 backdrop-blur-sm sm:left-4 sm:top-4">
        <p className="text-[10px] uppercase tracking-[0.16em]">Live G1 23-DoF simulation</p>
      </div>
      <div
        ref={cameraPadRef}
        role={isCameraPadCollapsed ? undefined : 'group'}
        aria-label={isCameraPadCollapsed ? undefined : '3D camera navigation'}
        className={`absolute z-20 max-h-[calc(100dvh-16px)] overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-slate-950/80 shadow-xl backdrop-blur-md ${isCameraPadCollapsed ? 'p-1' : 'p-2'}`}
        style={cameraPadPosition
          ? { left: cameraPadPosition.left, top: cameraPadPosition.top }
          : { left: 12, top: '50%', transform: 'translateY(-50%)' }}
        onPointerMove={moveCameraPad}
        onPointerUp={endCameraPadDrag}
        onPointerCancel={endCameraPadDrag}
      >
        {isCameraPadCollapsed ? (
          <button
            type="button"
            aria-label="Show camera controls"
            title="Show camera controls"
            onClick={() => setIsCameraPadCollapsed(false)}
            className="flex h-9 w-9 items-center justify-center rounded-md bg-cyan-700 text-white hover:bg-cyan-600"
          >
            <ChevronRight size={18} />
          </button>
        ) : (
          <>
            <div className="mb-1 flex items-center justify-between gap-2">
              <button
                type="button"
                aria-label="Move camera controls"
                title="Drag to move camera controls"
                onPointerDown={beginCameraPadDrag}
                className="flex min-h-8 flex-1 touch-none items-center gap-1 rounded-md px-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300 hover:bg-white/10"
              >
                <Grip size={14} />
                Camera
              </button>
              <button
                type="button"
                aria-label="Hide camera controls"
                title="Hide camera controls"
                onClick={() => setIsCameraPadCollapsed(true)}
                className="flex h-8 w-8 items-center justify-center rounded-md bg-slate-800 text-slate-200 hover:bg-cyan-800"
              >
                <ChevronLeft size={16} />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-1">
          <span />
          <button type="button" aria-label="Pan view up" title="Pan view up" onClick={() => panView(0, 1)} className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-800 text-slate-100 hover:bg-cyan-800 active:bg-cyan-700">
            <ArrowUp size={17} />
          </button>
          <span />
          <button type="button" aria-label="Pan view left" title="Pan view left" onClick={() => panView(-1, 0)} className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-800 text-slate-100 hover:bg-cyan-800 active:bg-cyan-700">
            <ArrowLeft size={17} />
          </button>
          <button type="button" aria-label="Pan view down" title="Pan view down" onClick={() => panView(0, -1)} className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-800 text-slate-100 hover:bg-cyan-800 active:bg-cyan-700">
            <ArrowDown size={17} />
          </button>
          <button type="button" aria-label="Pan view right" title="Pan view right" onClick={() => panView(1, 0)} className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-800 text-slate-100 hover:bg-cyan-800 active:bg-cyan-700">
            <ArrowRight size={17} />
          </button>
        </div>
        <div className="mt-1 flex justify-center gap-1">
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomView(1.12)} className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-800 text-slate-100 hover:bg-cyan-800 active:bg-cyan-700">
            <Minus size={17} />
          </button>
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomView(0.89)} className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-800 text-slate-100 hover:bg-cyan-800 active:bg-cyan-700">
            <Plus size={17} />
          </button>
          <button type="button" aria-label="Reset camera view" title="Reset camera view" onClick={resetView} className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-800 text-slate-100 hover:bg-cyan-800 active:bg-cyan-700">
            <RotateCcw size={16} />
          </button>
        </div>
          </>
        )}
      </div>
      <div
        role="group"
        aria-label="Motion playback controls"
        className={`absolute left-2 right-2 z-30 overflow-y-auto transition-transform sm:left-4 sm:right-4 ${isPlaybackBarOpen ? '' : 'translate-y-[calc(100%-2.5rem)]'}`}
        style={{ bottom: 'max(8px, env(safe-area-inset-bottom))', maxHeight: 'calc(100% - 16px)' }}
      >
        <div className="overflow-hidden rounded-xl border border-cyan-200/20 bg-slate-950/80 shadow-2xl backdrop-blur-md">
          <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
            <button type="button" onClick={() => setIsPlaybackBarOpen((value) => !value)} className="rounded-md p-1 text-slate-300 hover:bg-white/10" aria-label={isPlaybackBarOpen ? 'Collapse playback controls' : 'Expand playback controls'}>
              {isPlaybackBarOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-100">Motion playback</span>
            <span className="ml-auto text-[10px] text-slate-400">{Math.round(playbackProgress * 100)}%</span>
          </div>
          {isPlaybackBarOpen && (
            <div className="space-y-2 overflow-y-auto px-3 py-2" style={{ maxHeight: 'calc(100% - 48px)' }}>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => onPlaybackToggle?.(!isPlaying)} className="rounded-md bg-cyan-400 p-2 text-slate-950 hover:bg-cyan-300" aria-label={isPlaying ? 'Pause simulation' : 'Play simulation'}>
                  {isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
                </button>
                <button type="button" onClick={() => onPlaybackReset?.()} className="rounded-md bg-slate-800 p-2 text-slate-200 hover:bg-slate-700" aria-label="Reset simulation playback">
                  <RotateCcw size={15} />
                </button>
                <input aria-label="Motion timeline" type="range" min="0" max="1" step="0.001" value={playbackProgress} onChange={(event) => onPlaybackProgress?.(Number(event.target.value))} className="min-w-0 flex-1 accent-cyan-400" />
              </div>
              <div className="flex items-center gap-2 text-[10px] text-slate-300">
                <label htmlFor="motion-playback-speed" className="font-semibold uppercase tracking-wide text-cyan-100">Speed</label>
                <input id="motion-playback-speed" aria-label="Motion playback speed" type="range" min="0.1" max="3" step="0.1" value={playbackSpeed} onChange={(event) => onPlaybackSpeedChange?.(Number(event.target.value))} className="min-w-0 flex-1 accent-cyan-400" />
                <input aria-label="Motion playback speed value" type="number" min="0.1" max="3" step="0.1" value={playbackSpeed.toFixed(1)} onChange={(event) => onPlaybackSpeedChange?.(event.target.value)} className="w-14 rounded border border-white/15 bg-slate-900 px-1.5 py-1 text-right text-[10px] text-white" />
                <span className="text-slate-400">x</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
