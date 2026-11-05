import React, { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, RoundedBox } from "@react-three/drei";
import {
  BufferGeometry,
  CatmullRomCurve3,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Shape,
  Vector3,
} from "three";

const ROAD_WIDTH = 9;
const MAX_SPEED = 42;
const PLAYER_ID = "PLAYER-01";
const PLAYER_LANE = 2.15;
const AI_COUNT = 5;

export function getInitialVehiclePositions(collisionType) {
  if (collisionType === "rear-end") {
    return {
      vehicleA: { x: 0, z: 7 },
      vehicleB: { x: 0, z: 2 },
    };
  }

  return {
    vehicleA: { x: 0, z: 7 },
    vehicleB: { x: 0, z: -7 },
  };
}

export function getSimulatedCoordinates({ x, z }) {
  const center = [24.8607, 67.0011];
  const latitude = center[0] + Math.max(-15, Math.min(15, z)) * 0.0015;
  const longitude = center[1] + Math.max(-8, Math.min(8, x)) * 0.0015;

  return [latitude, longitude];
}

function createTrackPath() {
  return new CatmullRomCurve3(
    [
      [-13, 0, 9],
      [0, 0, 9],
      [13, 0, 9],
      [18, 0, 9],
      [21, 0, 7],
      [21, 0, 0],
      [21, 0, -7],
      [18, 0, -9],
      [13, 0, -9],
      [0, 0, -9],
      [-13, 0, -9],
      [-18, 0, -9],
      [-21, 0, -7],
      [-21, 0, 0],
      [-21, 0, 7],
      [-18, 0, 9],
    ].map(([x, y, z]) => new Vector3(x, y, z)),
    true,
    "catmullrom",
    0.18
  );
}

function createRoadGeometry(path) {
  const segments = 320;
  const vertices = new Float32Array((segments + 1) * 2 * 3);
  const indices = [];

  for (let index = 0; index <= segments; index += 1) {
    const progress = index / segments;
    const point = path.getPointAt(progress);
    const tangent = path.getTangentAt(progress);
    const sideX = tangent.z;
    const sideZ = -tangent.x;

    for (const [edge, direction] of [[0, -1], [1, 1]]) {
      const offset = index * 6 + edge * 3;
      vertices[offset] = point.x + sideX * (ROAD_WIDTH / 2) * direction;
      vertices[offset + 1] = -0.08;
      vertices[offset + 2] = point.z + sideZ * (ROAD_WIDTH / 2) * direction;
    }

    if (index < segments) {
      const start = index * 2;
      indices.push(start, start + 1, start + 2, start + 1, start + 3, start + 2);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createEdgeCurve(path, side) {
  const points = Array.from({ length: 180 }, (_, index) => {
    const progress = index / 180;
    const point = path.getPointAt(progress);
    const tangent = path.getTangentAt(progress);

    return new Vector3(
      point.x + tangent.z * (ROAD_WIDTH / 2 - 0.2) * side,
      -0.035,
      point.z - tangent.x * (ROAD_WIDTH / 2 - 0.2) * side
    );
  });

  return new CatmullRomCurve3(points, true, "catmullrom", 0.1);
}

function createCabinGeometry() {
  const profile = new Shape();
  profile.moveTo(0.82, 0.7);
  profile.lineTo(0.55, 1.15);
  profile.lineTo(0.25, 1.52);
  profile.lineTo(-0.45, 1.52);
  profile.lineTo(-0.9, 0.72);
  profile.closePath();

  return new ExtrudeGeometry(profile, {
    depth: 1.28,
    bevelEnabled: true,
    bevelSegments: 2,
    steps: 1,
    bevelSize: 0.035,
    bevelThickness: 0.035,
  });
}

function Car({ color, label, carRef }) {
  const cabinGeometry = useMemo(createCabinGeometry, []);

  useEffect(() => () => cabinGeometry.dispose(), [cabinGeometry]);

  return (
    <group ref={carRef}>
      <RoundedBox
        args={[1.72, 0.48, 3.75]}
        radius={0.16}
        smoothness={3}
        position={[0, 0.53, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={color} metalness={0.32} roughness={0.38} />
      </RoundedBox>

      <RoundedBox
        args={[1.61, 0.3, 1.12]}
        radius={0.12}
        smoothness={3}
        position={[0, 0.79, -1.12]}
        castShadow
      >
        <meshStandardMaterial color={color} metalness={0.28} roughness={0.4} />
      </RoundedBox>

      <RoundedBox
        args={[1.58, 0.27, 0.72]}
        radius={0.1}
        smoothness={3}
        position={[0, 0.76, 1.35]}
        castShadow
      >
        <meshStandardMaterial color={color} metalness={0.28} roughness={0.4} />
      </RoundedBox>

      <mesh
        geometry={cabinGeometry}
        position={[-0.64, 0, 0]}
        rotation-y={Math.PI / 2}
        castShadow
      >
        <meshStandardMaterial color={color} metalness={0.25} roughness={0.36} />
      </mesh>

      {[-1, 1].map((side) => (
        <React.Fragment key={side}>
          {[-0.42, 0.37].map((z) => (
            <mesh
              key={z}
              position={[side * 0.655, 1.24, z]}
              rotation-y={side * Math.PI / 2}
            >
              <planeGeometry args={[0.52, 0.34]} />
              <meshStandardMaterial
                color="#13283c"
                metalness={0.5}
                roughness={0.18}
                transparent
                opacity={0.92}
              />
            </mesh>
          ))}
        </React.Fragment>
      ))}

      {[-0.82, 0.82].map((x) =>
        [-1.12, 1.13].map((z) => (
          <group key={`${x}-${z}`} position={[x, 0.39, z]}>
            <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
              <cylinderGeometry args={[0.35, 0.35, 0.2, 20]} />
              <meshStandardMaterial color="#111820" roughness={0.85} />
            </mesh>
            <mesh
              position={[Math.sign(x) * 0.11, 0, 0]}
              rotation={[0, 0, Math.PI / 2]}
            >
              <cylinderGeometry args={[0.18, 0.18, 0.025, 20]} />
              <meshStandardMaterial
                color="#91a2b3"
                metalness={0.7}
                roughness={0.28}
              />
            </mesh>
          </group>
        ))
      )}

      {[-0.52, 0.52].map((x) => (
        <React.Fragment key={x}>
          <mesh position={[x, 0.72, -1.86]}>
            <RoundedBox args={[0.38, 0.13, 0.06]} radius={0.04}>
              <meshStandardMaterial
                color="#fff4c2"
                emissive="#ffc857"
                emissiveIntensity={1.4}
              />
            </RoundedBox>
          </mesh>
          <mesh position={[x, 0.7, 1.88]}>
            <RoundedBox args={[0.32, 0.12, 0.06]} radius={0.035}>
              <meshStandardMaterial color="#d92e43" emissive="#a51224" />
            </RoundedBox>
          </mesh>
        </React.Fragment>
      ))}

      <Html position={[0, 1.95, 0]} center distanceFactor={10} zIndexRange={[1, 0]}>
        <span className={`simulation-car-label ${label === "PLAYER" ? "vehicle-a-label" : "vehicle-b-label"}`}>
          {label}
        </span>
      </Html>
    </group>
  );
}

function CollisionBurst({ position }) {
  const effectRef = useRef(null);
  const materialRef = useRef(null);
  const startedAt = useRef(null);

  useFrame(({ clock }) => {
    if (!effectRef.current) return;
    if (startedAt.current === null) startedAt.current = clock.elapsedTime;
    const progress = Math.min((clock.elapsedTime - startedAt.current) / 0.9, 1);
    effectRef.current.scale.setScalar(0.45 + progress * 1.4);
    effectRef.current.rotation.y += 0.035;
    if (materialRef.current) materialRef.current.opacity = 1 - progress;
    effectRef.current.visible = progress < 1;
  });

  return (
    <group ref={effectRef} position={position}>
      <mesh rotation-x={Math.PI / 2}>
        <torusGeometry args={[0.55, 0.09, 8, 24]} />
        <meshBasicMaterial
          ref={materialRef}
          color="#ffd166"
          transparent
          opacity={1}
          depthWrite={false}
        />
      </mesh>
      {Array.from({ length: 8 }, (_, index) => {
        const angle = (index / 8) * Math.PI * 2;
        return (
          <mesh
            key={index}
            position={[Math.cos(angle) * 0.72, 0.2, Math.sin(angle) * 0.72]}
          >
            <octahedronGeometry args={[0.12, 0]} />
            <meshBasicMaterial
              color={index % 2 ? "#ff7b54" : "#ffe08a"}
              transparent
              opacity={0.9}
              depthWrite={false}
            />
          </mesh>
        );
      })}
    </group>
  );
}

function Scenery() {
  const objects = [
    [-26, -14],
    [-25, 0],
    [-26, 14],
    [26, -14],
    [25, 0],
    [26, 14],
    [-14, -15],
    [0, -15],
    [14, -15],
    [-14, 15],
    [0, 15],
    [14, 15],
  ];

  return (
    <>
      {objects.map(([x, z], index) => (
        <group key={`${x}-${z}`} position={[x, 0, z]}>
          <mesh position={[0, 0.7, 0]} castShadow>
            <cylinderGeometry args={[0.18, 0.28, 1.4, 8]} />
            <meshStandardMaterial color="#65452e" roughness={1} />
          </mesh>
          <mesh position={[0, 1.8, 0]} castShadow>
            <coneGeometry args={[index % 2 ? 1.05 : 0.85, 2.2, 8]} />
            <meshStandardMaterial color={index % 2 ? "#27694d" : "#347a55"} roughness={1} />
          </mesh>
        </group>
      ))}
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.16, 0]} receiveShadow>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial color="#193227" roughness={1} />
      </mesh>
    </>
  );
}

function createTraffic() {
  return Array.from({ length: AI_COUNT }, (_, index) => ({
    id: `AI-TRAFFIC-${String(index + 1).padStart(2, "0")}`,
    progress: 0.14 + index * 0.17,
    lane: index % 2 === 0 ? -2.05 : 2.05,
    baseSpeed: 7 + (index % 3) * 1.5,
    speed: 0,
    position: new Vector3(),
    yaw: 0,
  }));
}

function SimulationWorld({
  runId,
  resetKey,
  onCollision,
  onRestart,
  onTelemetry,
  onCollisionEvent,
}) {
  const { camera } = useThree();
  const trackPath = useMemo(createTrackPath, []);
  const trackLength = useMemo(() => trackPath.getLength(), [trackPath]);
  const roadGeometry = useMemo(() => createRoadGeometry(trackPath), [trackPath]);
  const edgePaths = useMemo(
    () => [-1, 1].map((side) => createEdgeCurve(trackPath, side)),
    [trackPath]
  );
  const playerRef = useRef(null);
  const trafficRefs = useRef([]);
  const player = useRef({
    position: new Vector3(),
    yaw: 0,
    speed: 0,
    steer: 0,
  });
  const traffic = useRef(createTraffic());
  const keys = useRef(new Set());
  const active = useRef(false);
  const collisionSent = useRef(false);
  const telemetryTime = useRef(0);
  const collisionCallback = useRef(onCollision);
  const restartCallback = useRef(onRestart);
  const telemetryCallback = useRef(onTelemetry);
  const collisionEventCallback = useRef(onCollisionEvent);
  const [collisionEffect, setCollisionEffect] = useState(null);

  collisionCallback.current = onCollision;
  restartCallback.current = onRestart;
  telemetryCallback.current = onTelemetry;
  collisionEventCallback.current = onCollisionEvent;

  useEffect(() => {
    return () => {
      roadGeometry.dispose();
    };
  }, [roadGeometry]);

  function resetWorld(shouldStart) {
    const start = trackPath.getPointAt(0.02);
    const tangent = trackPath.getTangentAt(0.02);
    player.current.position.set(
      start.x + tangent.z * PLAYER_LANE,
      0,
      start.z - tangent.x * PLAYER_LANE
    );
    player.current.yaw = Math.atan2(-tangent.x, -tangent.z);
    player.current.speed = 0;
    player.current.steer = 0;
    traffic.current = createTraffic();
    active.current = shouldStart;
    collisionSent.current = false;
    telemetryTime.current = 0;
    keys.current.clear();
    setCollisionEffect(null);

    if (playerRef.current) {
      playerRef.current.position.copy(player.current.position);
      playerRef.current.rotation.y = player.current.yaw;
    }

    traffic.current.forEach((vehicle, index) => {
      const point = trackPath.getPointAt(vehicle.progress);
      const tangentAtPoint = trackPath.getTangentAt(vehicle.progress);
      vehicle.position.set(
        point.x + tangentAtPoint.z * vehicle.lane,
        0,
        point.z - tangentAtPoint.x * vehicle.lane
      );
      vehicle.yaw = Math.atan2(-tangentAtPoint.x, -tangentAtPoint.z);
      if (trafficRefs.current[index]) {
        trafficRefs.current[index].position.copy(vehicle.position);
        trafficRefs.current[index].rotation.y = vehicle.yaw;
      }
    });

    telemetryCallback.current?.({ speed: 0, player: { x: start.x, z: start.z } });
  }

  useEffect(() => {
    resetWorld(false);
  }, [resetKey, trackPath]);

  useEffect(() => {
    if (runId > 0) resetWorld(true);
  }, [runId, trackPath]);

  useEffect(() => {
    const controlledKeys = new Set([
      "w",
      "a",
      "s",
      "d",
      "arrowup",
      "arrowdown",
      "arrowleft",
      "arrowright",
      " ",
    ]);

    function isEditableTarget(target) {
      return target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    }

    function handleKeyDown(event) {
      if (isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();

      if (key === "r") {
        event.preventDefault();
        restartCallback.current?.();
        return;
      }

      if (controlledKeys.has(key)) {
        event.preventDefault();
        keys.current.add(key);
      }
    }

    function handleKeyUp(event) {
      keys.current.delete(event.key.toLowerCase());
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    function handleBlur() {
      keys.current.clear();
    }

    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const state = player.current;
    const forward = new Vector3(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));

    if (active.current && !collisionSent.current) {
      const accelerating = keys.current.has("w") || keys.current.has("arrowup");
      const braking = keys.current.has("s") || keys.current.has("arrowdown");
      const emergencyBrake = keys.current.has(" ");
      const steering =
        Number(keys.current.has("d") || keys.current.has("arrowright")) -
        Number(keys.current.has("a") || keys.current.has("arrowleft"));

      if (accelerating) state.speed = Math.min(MAX_SPEED, state.speed + 7 * dt);
      else state.speed = Math.max(0, state.speed - 1.15 * dt);
      if (braking) state.speed = Math.max(0, state.speed - 12 * dt);
      if (emergencyBrake) state.speed = Math.max(0, state.speed - 25 * dt);

      state.steer += (steering - state.steer) * Math.min(1, dt * 7);
      const speedRatio = state.speed / MAX_SPEED;
      state.yaw += state.steer * (0.25 + speedRatio * 1.15) * dt;
      forward.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
      state.position.addScaledVector(forward, state.speed * dt);

      traffic.current.forEach((vehicle, index) => {
        let targetSpeed = vehicle.baseSpeed;
        for (const other of traffic.current) {
          if (other === vehicle || other.lane !== vehicle.lane) continue;
          const gap = ((other.progress - vehicle.progress + 1) % 1) * trackLength;
          if (gap > 0 && gap < 15) {
            targetSpeed = Math.min(
              targetSpeed,
              vehicle.baseSpeed * Math.max(0, (gap - 5) / 10)
            );
          }
        }

        const distanceToPlayer = vehicle.position.distanceTo(state.position);
        if (distanceToPlayer < 18) {
          targetSpeed = Math.min(
            targetSpeed,
            vehicle.baseSpeed * Math.max(0, (distanceToPlayer - 6) / 12)
          );
        }

        vehicle.speed += (targetSpeed - vehicle.speed) * Math.min(1, dt * 3.5);
        vehicle.progress = (vehicle.progress + (vehicle.speed * dt) / trackLength) % 1;
        const point = trackPath.getPointAt(vehicle.progress);
        const tangent = trackPath.getTangentAt(vehicle.progress);
        vehicle.position.set(
          point.x + tangent.z * vehicle.lane,
          0,
          point.z - tangent.x * vehicle.lane
        );
        vehicle.yaw = Math.atan2(-tangent.x, -tangent.z);

        const car = trafficRefs.current[index];
        if (car) {
          car.position.copy(vehicle.position);
          car.rotation.y = vehicle.yaw;
        }
      });

      const playerRight = new Vector3(Math.cos(state.yaw), 0, -Math.sin(state.yaw));
      const hit = traffic.current.find((vehicle) => {
        const separation = vehicle.position.clone().sub(state.position);
        const longitudinal = Math.abs(separation.dot(forward));
        const lateral = Math.abs(separation.dot(playerRight));
        return longitudinal < 3.9 && lateral < 1.85;
      });

      if (hit) {
        collisionSent.current = true;
        const playerSpeedAtImpact = state.speed;
        state.speed = 0;
        const midpoint = state.position.clone().add(hit.position).multiplyScalar(0.5);
        const playerVelocity = forward.clone().multiplyScalar(playerSpeedAtImpact);
        const trafficForward = new Vector3(-Math.sin(hit.yaw), 0, -Math.cos(hit.yaw));
        const trafficVelocity = trafficForward.multiplyScalar(hit.speed);
        const relativeSpeed = playerVelocity.distanceTo(trafficVelocity);
        const impactSpeedKmh = Math.round(relativeSpeed * 3.6);
        const event = {
          id: `SIM-${Date.now()}`,
          timestamp: new Date().toISOString(),
          vehicleAId: PLAYER_ID,
          vehicleBId: hit.id,
          speedA: Math.round(playerSpeedAtImpact * 3.6),
          speedB: Math.round(hit.speed * 3.6),
          collisionType: "rear-end",
          impactInfo: {
            estimatedClosingSpeedKmh: impactSpeedKmh,
            separationMeters: Number(state.position.distanceTo(hit.position).toFixed(2)),
            positionMeters: {
              x: Number(midpoint.x.toFixed(2)),
              z: Number(midpoint.z.toFixed(2)),
            },
          },
          simulationCoordinates: {
            x: Number(midpoint.x.toFixed(2)),
            z: Number(midpoint.z.toFixed(2)),
            unit: "simulation meters",
          },
        };
        setCollisionEffect([midpoint.x, 1.1, midpoint.z]);
        collisionEventCallback.current?.(event);
        collisionCallback.current?.(event);
      }

      telemetryTime.current += dt;
      if (telemetryTime.current >= 0.12) {
        telemetryTime.current = 0;
        telemetryCallback.current?.({
          speed: Math.round(state.speed * 3.6),
          player: { x: state.position.x, z: state.position.z },
        });
      }
    }

    if (playerRef.current) {
      playerRef.current.position.copy(state.position);
      playerRef.current.rotation.y = state.yaw;
    }

    const desiredCameraPosition = state.position
      .clone()
      .addScaledVector(forward, -10)
      .add(new Vector3(0, 8, 0));
    camera.position.lerp(desiredCameraPosition, 1 - Math.exp(-4 * dt));
    camera.lookAt(
      state.position.x + forward.x * 2.5,
      state.position.y + 1.1,
      state.position.z + forward.z * 2.5
    );
  });

  const roadMarkings = useMemo(
    () =>
      Array.from({ length: 100 }, (_, index) => {
        const progress = index / 100;
        const point = trackPath.getPointAt(progress);
        const tangent = trackPath.getTangentAt(progress);
        return {
          key: index,
          position: [point.x, -0.025, point.z],
          rotation: Math.atan2(-tangent.x, -tangent.z),
        };
      }),
    [trackPath]
  );

  return (
    <>
      <color attach="background" args={["#0b1420"]} />
      <fog attach="fog" args={["#193227", 38, 75]} />
      <ambientLight intensity={1.2} />
      <directionalLight
        position={[10, 18, 8]}
        intensity={2.2}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <pointLight position={[-12, 7, -8]} color="#3977a8" intensity={20} />
      <Scenery />

      <mesh geometry={roadGeometry} receiveShadow>
        <meshStandardMaterial color="#303842" roughness={0.92} side={2} />
      </mesh>
      {edgePaths.map((path, index) => (
        <mesh key={index}>
          <tubeGeometry args={[path, 180, 0.075, 6, true]} />
          <meshStandardMaterial color="#f0c866" emissive="#614a16" />
        </mesh>
      ))}
      {roadMarkings.map((marking) => (
        <mesh
          key={marking.key}
          position={marking.position}
          rotation-y={marking.rotation}
        >
          <boxGeometry args={[0.11, 0.025, 1.2]} />
          <meshStandardMaterial color="#e2e7e9" />
        </mesh>
      ))}

      <Car carRef={playerRef} label="PLAYER" color="#1687ff" />
      {traffic.current.map((vehicle, index) => (
        <Car
          key={vehicle.id}
          carRef={(element) => {
            trafficRefs.current[index] = element;
          }}
          label={vehicle.id}
          color={["#ed594d", "#e7a843", "#45b889", "#a36be4", "#e7e3da"][index]}
        />
      ))}
      {collisionEffect && <CollisionBurst position={collisionEffect} />}
      <Html position={[-4, 0.05, 12]} transform distanceFactor={14} zIndexRange={[1, 0]}>
        <span className="road-direction-label">TRAFFIC CIRCUIT · DEMO</span>
      </Html>
    </>
  );
}

export default function AccidentGame({
  runId,
  resetKey,
  onCollision,
  onRestart,
}) {
  const [speed, setSpeed] = useState(0);
  const [collisionEvent, setCollisionEvent] = useState(null);
  const [started, setStarted] = useState(false);

  const handleTelemetry = ({ speed: nextSpeed }) => {
    setSpeed((previousSpeed) =>
      previousSpeed === nextSpeed ? previousSpeed : nextSpeed
    );
  };

  const handleCollisionEvent = (event) => {
    setCollisionEvent(event);
    setStarted(false);
  };

  useEffect(() => {
    if (runId > 0) setStarted(true);
  }, [runId]);

  useEffect(() => {
    setSpeed(0);
    setCollisionEvent(null);
    setStarted(false);
  }, [resetKey]);

  return (
    <div className="collision-simulation driving-simulation" aria-label="Playable 3D driving simulator">
      <div className="simulation-speed-readout">
        <span className="speed-readout-a">PLAYER · {speed} km/h</span>
        <span className="simulation-readout-hint">
          {collisionEvent ? "COLLISION PAUSED" : started ? "DRIVING" : "READY"}
        </span>
        <span className="speed-readout-b">TRAFFIC · {AI_COUNT} AI</span>
      </div>
      <Canvas
        shadows="basic"
        dpr={[1, 1.5]}
        camera={{ position: [0, 8, 18], fov: 48 }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
      >
        <SimulationWorld
          runId={runId}
          resetKey={resetKey}
          onCollision={onCollision}
          onRestart={onRestart}
          onTelemetry={handleTelemetry}
          onCollisionEvent={handleCollisionEvent}
        />
      </Canvas>

      <div className="driving-controls-hud">
        <span><kbd>W</kbd> / <kbd>↑</kbd> Accelerate</span>
        <span><kbd>S</kbd> / <kbd>↓</kbd> Brake</span>
        <span><kbd>A</kbd> <kbd>D</kbd> / <kbd>←</kbd> <kbd>→</kbd> Steer</span>
        <span><kbd>Space</kbd> Emergency brake</span>
        <span><kbd>R</kbd> Restart</span>
      </div>

      {collisionEvent && (
        <div className="driving-collision-alert" role="status">
          <strong>SIMULATION COLLISION</strong>
          <span>
            {collisionEvent.vehicleAId} · {collisionEvent.vehicleBId}
          </span>
          <span>
            Approx. closing speed: {collisionEvent.impactInfo.estimatedClosingSpeedKmh} km/h
          </span>
          <small>{new Date(collisionEvent.timestamp).toLocaleTimeString()}</small>
        </div>
      )}
    </div>
  );
}
