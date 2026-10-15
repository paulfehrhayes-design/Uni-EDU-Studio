import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ChevronDown, ChevronUp, Pause, Play, RotateCcw } from 'lucide-react';
import { buildG1SimulationFrames, G1_EDU_23_ENV } from '../sim/g1Edu23Env';
import { getSceneObjectScale } from '../sim/sceneObjects';

const JOINT_AXES = {
  left_hip_pitch: 'x', right_hip_pitch: 'x', left_knee: 'x', right_knee: 'x', left_knee_pitch: 'x', right_knee_pitch: 'x',
  left_ankle_pitch: 'x', right_ankle_pitch: 'x', waist_pitch: 'x',
  left_hip_roll: 'z', right_hip_roll: 'z', left_ankle_roll: 'z', right_ankle_roll: 'z', waist_roll: 'z',
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
  const waistPitch = new THREE.Group();
  waistYaw.add(waistPitch);
  const waistRoll = new THREE.Group();
  waistPitch.add(waistRoll);
  addBox(waistRoll, [0.62, 0.72, 0.38], [0, 0.38, 0], dark, 0);
  addBox(waistRoll, [0.4, 0.3, 0.42], [0, 0.76, 0], light, 0);

  const head = register('head', waistRoll, [0, 0.95, 0]);
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
    const shoulderPitch = register(`${side}_shoulder_pitch_joint`, waistRoll, [x, 0.68, 0]);
    const shoulderRoll = register(`${side}_shoulder_roll_joint`, shoulderPitch);
    const shoulderYaw = register(`${side}_shoulder_yaw_joint`, shoulderRoll);
    addSegment(shoulderYaw, [0, 0, 0], [0, -0.48, 0], 0.1, light);
    const elbow = register(`${side}_elbow_joint`, shoulderYaw, [0, -0.48, 0]);
    addSegment(elbow, [0, 0, 0], [0, -0.46, 0], 0.085, dark);
    const wrist = register(`${side}_wrist_roll_joint`, elbow, [0, -0.46, 0]);
    addBox(wrist, [0.16, 0.2, 0.2], [0, -0.1, 0], light, 0);
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

function interpolateAngle(from = 0, to = 0, amount) {
  const delta = ((to - from + 540) % 360) - 180;
  return from + delta * amount;
}

function easeMotion(amount) {
  return amount * amount * (3 - 2 * amount);
}

function interpolateSimulationFrame(from, to, amount) {
  if (!from) return to;
  if (!to) return from;
  const eased = easeMotion(amount);
  const joints = {};
  const jointNames = new Set([...Object.keys(from.joints || {}), ...Object.keys(to.joints || {})]);
  jointNames.forEach((name) => {
    joints[name] = THREE.MathUtils.lerp(Number(from.joints?.[name] ?? 0), Number(to.joints?.[name] ?? 0), eased);
  });
  return {
    ...to,
    time: THREE.MathUtils.lerp(from.time || 0, to.time || 0, eased),
    x: THREE.MathUtils.lerp(from.x || 0, to.x || 0, amount),
    y: THREE.MathUtils.lerp(from.y || 0, to.y || 0, amount),
    heading: interpolateAngle(from.heading || 0, to.heading || 0, amount),
    torsoPitch: THREE.MathUtils.lerp(from.torsoPitch || 0, to.torsoPitch || 0, eased),
    torsoRoll: THREE.MathUtils.lerp(from.torsoRoll || 0, to.torsoRoll || 0, eased),
    joints,
    path: from.path || to.path || [],
  };
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
    parent.add(body);

    const joint = bodyElement.querySelector(':scope > joint');
    if (joint?.getAttribute('name')) joints[joint.getAttribute('name')] = body;

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

export default function G1Simulation3D({ code, simulatorState, obstacles = [], waypoints = [], onObstacleChange, onObstacleSelect, onWaypointChange, isWaypointPlacementEnabled = false, onWaypointPlace, isPlaying = false, playbackSpeed = 1, playbackProgress = 0, gridSize = 20, onPlaybackProgress, onPlaybackToggle, onPlaybackReset, onPlaybackSpeedChange }) {
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
    yaw: 0.55,
    pitch: 0.62,
    distance: 7,
    target: new THREE.Vector3(0, 1.05, 0),
    focusOffset: new THREE.Vector3(0, 0, 0),
    pointers: new Map(),
    pinchDistance: 0,
    pinchMidpoint: null,
  });
  const isPlayingRef = useRef(isPlaying);
  const playbackSpeedRef = useRef(playbackSpeed);
  const playbackProgressRef = useRef(playbackProgress);
  const playbackProgressCallbackRef = useRef(onPlaybackProgress);
  const playbackToggleCallbackRef = useRef(onPlaybackToggle);
  const [isPlaybackBarOpen, setIsPlaybackBarOpen] = useState(true);
  const [renderError, setRenderError] = useState('');

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
    const radius = Math.hypot((bounds.maxX - bounds.minX) / 2, (bounds.maxY - bounds.minY) / 2);
    const verticalFov = THREE.MathUtils.degToRad(camera?.fov ?? 42);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * (camera?.aspect ?? 1));
    const requiredDistance = Math.max(
      radius / Math.tan(horizontalFov / 2),
      (radius * Math.sin(view.pitch) + 1.8) / Math.tan(verticalFov / 2),
    ) * 1.15;

    view.target.set(
      (bounds.minX + bounds.maxX) / 2 + view.focusOffset.x,
      1.05 + view.focusOffset.y,
      -(bounds.minY + bounds.maxY) / 2 + view.focusOffset.z,
    );
    view.distance = Math.max(7, requiredDistance);
  }, [waypoints]);

  useEffect(() => {
    framesRef.current = buildG1SimulationFrames(code, {
      obstacles,
      challenge: simulatorState?.goal ? { goal: simulatorState.goal } : null,
    });
  }, [code, obstacles, simulatorState?.goal]);

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
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    const updateCamera = () => {
      const view = viewRef.current;
      camera.position.set(
        view.target.x + Math.sin(view.yaw) * Math.cos(view.pitch) * view.distance,
        view.target.y + Math.sin(view.pitch) * view.distance,
        view.target.z + Math.cos(view.yaw) * Math.cos(view.pitch) * view.distance,
      );
      camera.lookAt(view.target);
    };
    updateCamera();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
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
      readPointer(event);
      if (waypointPlacementEnabledRef.current) {
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
      const waypointHit = raycaster.intersectObjects(waypointGroup.children, true)
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
      const obstacleHit = raycaster.intersectObjects(obstacleGroup.children, true)
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
      view.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      renderer.domElement.setPointerCapture?.(event.pointerId);
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
      view.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

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
        view.yaw -= deltaX * 0.008;
        view.pitch = Math.max(0.2, Math.min(1.35, view.pitch - deltaY * 0.006));
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
      view.pointers.delete(event.pointerId);
      if (view.pointers.size < 2) {
        view.pinchDistance = 0;
        view.pinchMidpoint = null;
      }
    };
    const onWheel = (event) => {
      const zoomFactor = Math.exp(event.deltaY * 0.0012);
      viewRef.current.distance = Math.max(2.5, Math.min(30, viewRef.current.distance * zoomFactor));
      updateCamera();
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: true });

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
          const stateName = normalizedName.endsWith('_knee') ? `${normalizedName}_pitch` : normalizedName;
          const value = Number(frame.joints?.[normalizedName] ?? frame.joints?.[stateName] ?? frame.joints?.[name] ?? 0);
          const axis = JOINT_AXES[normalizedName] || (normalizedName.includes('pitch') ? 'x' : 'y');
          group.rotation[axis] = THREE.MathUtils.degToRad(value);
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
  }, [gridSize]);

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
      <div className="pointer-events-none absolute left-4 top-4 rounded-lg border border-cyan-300/20 bg-slate-950/55 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-cyan-100 backdrop-blur-sm">
        Live G1 23-DoF simulation
      </div>
      <div className={`absolute bottom-4 left-4 right-4 z-30 transition-transform ${isPlaybackBarOpen ? '' : 'translate-y-[calc(100%-2.5rem)]'}`}>
        <div className="overflow-hidden rounded-xl border border-cyan-200/20 bg-slate-950/80 shadow-2xl backdrop-blur-md">
          <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
            <button type="button" onClick={() => setIsPlaybackBarOpen((value) => !value)} className="rounded-md p-1 text-slate-300 hover:bg-white/10" aria-label={isPlaybackBarOpen ? 'Collapse playback controls' : 'Expand playback controls'}>
              {isPlaybackBarOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-100">Motion playback</span>
            <span className="ml-auto text-[10px] text-slate-400">{Math.round(playbackProgress * 100)}%</span>
          </div>
          {isPlaybackBarOpen && (
            <div className="space-y-2 px-3 py-2">
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
