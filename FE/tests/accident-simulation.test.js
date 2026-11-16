import assert from "node:assert/strict";
import {
  bearingAtFraction,
  buildRoutePair,
  findRouteIntersections,
  findVehicleCollisions,
  findVehicleCollisionsAlongInterval,
  fetchJsonWithTimeout,
  normalizeNavigationRoutes,
  parseNearbyHospitals,
  pointBeforeEnd,
  pointAtFraction,
} from "../src/components/accidentSimulationUtils.js";

const routeA = {
  distance: 1200,
  coordinates: [
    [24.9, 67.09],
    [24.91, 67.09],
    [24.92, 67.09],
  ],
};
const routeB = {
  distance: 1800,
  coordinates: [
    [24.92, 67.06],
    [24.92, 67.075],
    [24.92, 67.09],
  ],
};
const pair = buildRoutePair(routeA, routeB, [24.92, 67.09]);

assert.deepEqual(pair.vehicleA.coordinates.at(-1), pair.collisionPoint);
assert.deepEqual(pair.vehicleB.coordinates.at(-1), pair.collisionPoint);
assert.notDeepEqual(
  pointBeforeEnd(pair.vehicleA.coordinates),
  pair.collisionPoint
);
assert.equal(
  Math.abs(
    bearingAtFraction(
      [
        [0, 0],
        [0, 1],
      ],
      0.5,
      true
    ) - 270
  ) < 0.01,
  true
);
const eastWestRoute = [
  [24.9, 67.0],
  [24.9, 67.04],
];
const northSouthRouteA = [
  [24.89, 67.01],
  [24.91, 67.01],
];
const northSouthRouteB = [
  [24.89, 67.03],
  [24.91, 67.03],
];
const intersectionA = findRouteIntersections(
  eastWestRoute,
  northSouthRouteA
)[0];
const intersectionB = findRouteIntersections(
  eastWestRoute,
  northSouthRouteB
)[0];
assert.ok(intersectionA);
assert.ok(intersectionB);
assert.ok(
  Math.abs(intersectionA.location[1] - intersectionB.location[1]) > 0.015
);
const sweptCollision = findVehicleCollisions(
  [
    { id: "car-a", position: [24.9, 67.1] },
    { id: "car-b", position: [24.901, 67.1] },
  ],
  [
    { id: "car-a", position: [24.902, 67.1] },
    { id: "car-b", position: [24.901, 67.1] },
  ]
);
assert.equal(sweptCollision.length, 1);
assert.deepEqual(sweptCollision[0].vehicleAId, "car-a");
assert.deepEqual(sweptCollision[0].vehicleBId, "car-b");
const separatedVehicles = findVehicleCollisions(
  [{ id: "car-a", position: [24.9, 67.1] }, { id: "car-b", position: [25, 67.1] }],
  [{ id: "car-a", position: [24.9001, 67.1] }, { id: "car-b", position: [25, 67.1] }]
);
assert.equal(separatedVehicles.length, 0);
assert.equal(
  findVehicleCollisionsAlongInterval(
    (elapsedMs) => [
      { id: "safe-a", position: [24.9, 67.1 + (elapsedMs / 1000) * 0.001] },
      { id: "safe-b", position: [24.91, 67.1] },
    ],
    0,
    1000
  ),
  null,
  "vehicles moving on separated paths produce no collision"
);
const positionsAlongCrossingRoads = (elapsedMs) => {
  const firstVehicle =
    elapsedMs <= 500
      ? [24.9, 67.1 + (elapsedMs / 500) * 0.002]
      : [24.9 + ((elapsedMs - 500) / 500) * 0.002, 67.102];
  const secondVehicle = [
    elapsedMs <= 500 ? 24.902 - (elapsedMs / 500) * 0.002 : 24.9,
    67.102,
  ];
  return [
    { id: "route-a", position: firstVehicle },
    { id: "route-b", position: secondVehicle },
  ];
};
assert.equal(
  findVehicleCollisions(
    positionsAlongCrossingRoads(0),
    positionsAlongCrossingRoads(1000),
    18
  ).length,
  0,
  "a straight chord across the interval must not invent a collision"
);
const routeSampledCollision = findVehicleCollisionsAlongInterval(
  positionsAlongCrossingRoads,
  0,
  1000
);
assert.equal(routeSampledCollision.collisions.length, 1);
assert.equal(routeSampledCollision.collisions[0].vehicleAId, "route-a");
assert.equal(routeSampledCollision.collisions[0].vehicleBId, "route-b");
const multipleVehiclePositions = (elapsedMs) => [
  {
    id: "vehicle-a",
    position: [24.9, 67.1 + (elapsedMs / 1000) * 0.002],
  },
  { id: "vehicle-b", position: [24.9, 67.101] },
  {
    id: "vehicle-c",
    position: [24.91, 67.1 + (elapsedMs / 1000) * 0.002],
  },
  { id: "vehicle-d", position: [24.91, 67.1016] },
  {
    id: "vehicle-e",
    position: [24.92, 67.1 + (elapsedMs / 1000) * 0.001],
  },
];
const multipleCollisions = findVehicleCollisionsAlongInterval(
  multipleVehiclePositions,
  0,
  1000
);
assert.deepEqual(
  multipleCollisions.collisions
    .map((collision) =>
      [collision.vehicleAId, collision.vehicleBId].sort().join(":")
    )
    .sort(),
  ["vehicle-a:vehicle-b", "vehicle-c:vehicle-d"]
);
assert.equal(
  multipleCollisions.currentPositions.find(
    (vehicle) => vehicle.id === "vehicle-e"
  ).position[1],
  67.101,
  "vehicles outside the collision continue moving through the interval"
);
assert.equal(
  multipleCollisions.collisions.filter(
    (collision) =>
      collision.vehicleAId === "vehicle-a" &&
      collision.vehicleBId === "vehicle-b"
  ).length,
  1,
  "a pair that remains in contact produces one event"
);
assert.notDeepEqual(
  pointBeforeEnd(pair.vehicleB.coordinates),
  pair.collisionPoint
);
assert.notDeepEqual(
  pointAtFraction(pair.vehicleA.coordinates, 0.5),
  pointAtFraction(pair.vehicleB.coordinates, 0.5)
);
const routeWithRepeatedPoint = [
  [0, 0],
  [0, 0],
  [0, 2],
];
assert.deepEqual(pointAtFraction(routeWithRepeatedPoint, 0), [0, 0]);
assert.deepEqual(pointAtFraction(routeWithRepeatedPoint, 0.5), [0, 1]);
assert.deepEqual(pointAtFraction(routeWithRepeatedPoint, 1), [0, 2]);
assert.deepEqual(
  normalizeNavigationRoutes(
    [
      {
        distance: 1200,
        duration: 300,
        geometry: { coordinates: [[67, 24], [67.01, 24.01]] },
      },
      {
        distance: Number.NaN,
        duration: 100,
        geometry: { coordinates: [[67, 24], [67.01, 24.01]] },
      },
    ],
    "test"
  ),
  [
    {
      id: "test-0",
      coordinates: [
        [24, 67],
        [24.01, 67.01],
      ],
      distanceKm: 1.2,
      durationSeconds: 300,
    },
  ]
);
assert.throws(
  () =>
    normalizeNavigationRoutes([
      {
        distance: 1200,
        duration: 300,
        geometry: { coordinates: [[181, 24], [67.01, 24.01]] },
      },
    ]),
  /No usable road route/
);
assert.deepEqual(
  parseNearbyHospitals(
    [
      null,
      {
        type: "way",
        id: 8,
        center: { lat: 24.9, lon: 67.1 },
        tags: {
          name: "Karachi Hospital",
          "addr:street": "Main Road",
          "addr:city": "Karachi",
          phone: "+92 21 5550000",
        },
      },
      {
        type: "node",
        id: 9,
        lat: 24.9,
        lon: 67.1,
        tags: { name: "Karachi Hospital" },
      },
      {
        type: "node",
        id: 10,
        lat: 91,
        lon: 67.1,
        tags: { name: "Invalid location" },
      },
    ],
    [24.9, 67.1]
  ),
  [
    {
      id: "way-8",
      name: "Karachi Hospital",
      address: "Main Road, Karachi",
      phone: "+92 21 5550000",
      lat: 24.9,
      lon: 67.1,
      distance: 0,
    },
  ]
);
assert.equal(
  parseNearbyHospitals(
    [{ lat: 24.91, lon: 67.1, tags: { name: "Hospital without OSM ID" } }],
    [24.9, 67.1]
  )[0].id,
  "osm-24.91000-67.10000"
);

assert.throws(
  () =>
    buildRoutePair(
      { coordinates: [[24.9, 67.09], [24.92, 67.09]] },
      { coordinates: [[24.91, 67.09], [24.92, 67.09]] },
      [24.92, 67.09]
    ),
  /separate starting locations|distinct directions/
);

const originalFetch = globalThis.fetch;
globalThis.fetch = () => new Promise(() => {});
try {
  await assert.rejects(
    fetchJsonWithTimeout("https://example.test/hospitals", {
      timeoutMs: 10,
    }),
    (error) => error.name === "TimeoutError"
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Accident simulation route tests passed.");
