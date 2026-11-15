export function distanceKm(a, b) {
  const radians = (value) => (value * Math.PI) / 180;
  const dLat = radians(b[0] - a[0]);
  const dLon = radians(b[1] - a[1]);
  const lat1 = radians(a[0]);
  const lat2 = radians(b[0]);
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

const routeMeasures = new WeakMap();

function measureRoute(points) {
  const cached = routeMeasures.get(points);
  if (cached) return cached;

  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(
      cumulative[i - 1] + distanceKm(points[i - 1], points[i])
    );
  }

  const measured = { cumulative, total: cumulative[cumulative.length - 1] };
  routeMeasures.set(points, measured);
  return measured;
}

export function pointAtFraction(points, fraction) {
  if (!points?.length) return [24.8607, 67.0011];
  if (points.length === 1) return points[0];

  const { cumulative, total } = measureRoute(points);
  const target = total * Math.max(0, Math.min(1, fraction));
  let low = 0;
  let high = points.length - 2;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (cumulative[middle + 1] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const segmentLength = cumulative[low + 1] - cumulative[low];
  const ratio =
    segmentLength === 0 ? 0 : (target - cumulative[low]) / segmentLength;

  return [
    points[low][0] + (points[low + 1][0] - points[low][0]) * ratio,
    points[low][1] + (points[low + 1][1] - points[low][1]) * ratio,
  ];
}

export function bearingAtFraction(points, fraction) {
  const before = pointAtFraction(points, Math.max(0, fraction - 0.002));
  const after = pointAtFraction(points, Math.min(1, fraction + 0.002));
  const radians = (value) => (value * Math.PI) / 180;
  const degrees = (value) => (value * 180) / Math.PI;
  const lat1 = radians(before[0]);
  const lat2 = radians(after[0]);
  const dLon = radians(after[1] - before[1]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (degrees(Math.atan2(y, x)) + 360) % 360;
}

export function buildRoutePair(routeA, routeB, destination) {
  if (
    !Array.isArray(routeA?.coordinates) ||
    !Array.isArray(routeB?.coordinates) ||
    routeA.coordinates.length < 2 ||
    routeB.coordinates.length < 2
  ) {
    throw new Error("Both vehicle routes must contain road coordinates.");
  }

  const endA = routeA.coordinates[routeA.coordinates.length - 1];
  const endB = routeB.coordinates[routeB.coordinates.length - 1];
  if (distanceKm(endA, endB) > 0.08) {
    throw new Error("The two road routes do not meet at the same collision point.");
  }

  const collisionPoint = [
    (endA[0] + endB[0]) / 2,
    (endA[1] + endB[1]) / 2,
  ];
  if (distanceKm(collisionPoint, destination) > 0.25) {
    throw new Error("The selected collision point is not close to a routable road.");
  }
  if (distanceKm(routeA.coordinates[0], routeB.coordinates[0]) < 1) {
    throw new Error("The vehicles need separate starting locations.");
  }

  const headingA = bearingAtFraction(routeA.coordinates, 0.99);
  const headingB = bearingAtFraction(routeB.coordinates, 0.99);
  const approachAngle = Math.abs(((headingA - headingB + 540) % 360) - 180);
  if (approachAngle < 25 || approachAngle > 155) {
    throw new Error("The two road approaches must meet from distinct directions.");
  }

  const endAtCollisionPoint = (route) => ({
    ...route,
    coordinates: [
      ...route.coordinates.slice(0, -1),
      collisionPoint,
    ],
  });

  return {
    vehicleA: endAtCollisionPoint(routeA),
    vehicleB: endAtCollisionPoint(routeB),
    collisionPoint,
  };
}
