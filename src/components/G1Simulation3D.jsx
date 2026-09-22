import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { buildG1SimulationFrames, G1_EDU_23_ENV } from '../sim/g1Edu23Env';

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

export default function G1Simulation3D({ code, simulatorState, obstacles = [], isPlaying = false }) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const framesRef = useRef([]);
  const cameraRef = useRef(null);
  const robotRef = useRef(null);
  const jointRefs = useRef({});
  const obstacleGroupRef = useRef(null);
  const simulatorStateRef = useRef(simulatorState);
  const viewRef = useRef({ yaw: 0.55, pitch: 0.62, distance: 7, dragging: false, x: 0, y: 0 });
  const isPlayingRef = useRef(isPlaying);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    simulatorStateRef.current = simulatorState;
  }, [simulatorState]);

  useEffect(() => {
    framesRef.current = buildG1SimulationFrames(code, {
      obstacles,
      challenge: simulatorState?.goal ? { goal: simulatorState.goal } : null,
    });
  }, [code, obstacles, simulatorState?.goal]);

  useEffect(() => {
    const group = obstacleGroupRef.current;
    if (!group) return;
    group.clear();
    obstacles.forEach((obstacle) => {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(Math.max(0.18, obstacle.radius / 12), Math.max(0.26, obstacle.radius / 10), 0.25, 24),
        new THREE.MeshStandardMaterial({ color: String(obstacle.id).startsWith('student-') ? 0x8b5cf6 : 0xf59e0b, transparent: true, opacity: 0.72 }),
      );
      mesh.position.set(obstacle.x / 5, 0.13, -obstacle.y / 5);
      mesh.castShadow = true;
      group.add(mesh);
    });
  }, [obstacles]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x08111d);
    scene.fog = new THREE.Fog(0x08111d, 8, 22);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    cameraRef.current = camera;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);
    sceneRef.current = scene;

    scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x152234, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(4, 8, 5);
    key.castShadow = true;
    scene.add(key);
    const rim = new THREE.PointLight(0x22d3ee, 16, 12);
    rim.position.set(-4, 3, -3);
    scene.add(rim);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x0e1b2a, roughness: 0.85, metalness: 0.1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(40, 40, 0x2b6b83, 0x163449);
    grid.position.y = 0.01;
    scene.add(grid);

    const goal = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.76, 48), new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    goal.rotation.x = -Math.PI / 2;
    goal.position.y = 0.03;
    scene.add(goal);

    const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.6 }));
    scene.add(pathLine);

    const obstacleGroup = new THREE.Group();
    obstacleGroupRef.current = obstacleGroup;
    scene.add(obstacleGroup);

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
        Math.sin(view.yaw) * Math.cos(view.pitch) * view.distance,
        Math.sin(view.pitch) * view.distance + 1.1,
        Math.cos(view.yaw) * Math.cos(view.pitch) * view.distance,
      );
      camera.lookAt(0, 1.05, 0);
    };
    updateCamera();

    const onPointerDown = (event) => {
      viewRef.current.dragging = true;
      viewRef.current.x = event.clientX;
      viewRef.current.y = event.clientY;
      renderer.domElement.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event) => {
      const view = viewRef.current;
      if (!view.dragging) return;
      view.yaw -= (event.clientX - view.x) * 0.008;
      view.pitch = Math.max(0.2, Math.min(1.35, view.pitch + (event.clientY - view.y) * 0.006));
      view.x = event.clientX;
      view.y = event.clientY;
      updateCamera();
    };
    const onPointerUp = () => { viewRef.current.dragging = false; };
    const onWheel = (event) => {
      viewRef.current.distance = Math.max(3.8, Math.min(11, viewRef.current.distance + event.deltaY * 0.008));
      updateCamera();
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: true });

    const clock = new THREE.Clock();
    const animate = () => {
      const elapsed = clock.getElapsedTime();
      const frames = framesRef.current;
      const frameIndex = frames.length && isPlayingRef.current ? Math.floor(elapsed * 2.2) % frames.length : Math.max(0, frames.length - 1);
      const frame = frames[frameIndex] || simulatorStateRef.current;
      if (robotRef.current && frame) {
        robotRef.current.position.set((frame.x || 0) / 5, 0, -(frame.y || 0) / 5);
        robotRef.current.rotation.y = THREE.MathUtils.degToRad(-(frame.heading || 0));
        Object.entries(jointRefs.current).forEach(([name, group]) => {
          const normalizedName = name.replace('_joint', '');
          const stateName = normalizedName.endsWith('_knee') ? `${normalizedName}_pitch` : normalizedName;
          const value = Number(frame.joints?.[name] ?? frame.joints?.[normalizedName] ?? frame.joints?.[stateName] ?? 0);
          const axis = JOINT_AXES[normalizedName] || (normalizedName.includes('pitch') ? 'x' : 'y');
          group.rotation[axis] = THREE.MathUtils.degToRad(value);
        });
        const path = frame.path || [];
        pathLine.geometry.setFromPoints(path.map((point) => new THREE.Vector3(point.x / 5, 0.035, -point.y / 5)));
        if (frame.goal) {
          goal.visible = true;
          goal.position.set(frame.goal.x / 5, 0.03, -frame.goal.y / 5);
        } else {
          goal.visible = false;
        }
      }
      renderer.render(scene, camera);
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
      renderer.domElement.removeEventListener('pointerleave', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div ref={mountRef} className="absolute inset-0 overflow-hidden" aria-label={`Live ${G1_EDU_23_ENV.robotType} 3D simulation`}>
      <div className="pointer-events-none absolute left-4 top-4 rounded-lg border border-cyan-300/20 bg-slate-950/55 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-cyan-100 backdrop-blur-sm">
        Live G1 23-DoF simulation
      </div>
    </div>
  );
}
