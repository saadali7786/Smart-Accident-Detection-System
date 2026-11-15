import assert from "node:assert/strict";
import {
  buildRoutePair,
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

assert.throws(
  () =>
    buildRoutePair(
      { coordinates: [[24.9, 67.09], [24.92, 67.09]] },
      { coordinates: [[24.91, 67.09], [24.92, 67.09]] },
      [24.92, 67.09]
    ),
  /separate starting locations|distinct directions/
);

console.log("Accident simulation route tests passed.");
