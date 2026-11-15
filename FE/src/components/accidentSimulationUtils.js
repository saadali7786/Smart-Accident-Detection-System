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

export async function fetchJsonWithTimeout(
  url,
  { signal, timeoutMs = 12000 } = {}
) {
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort(signal.reason);
  if (signal?.aborted) {
    abortRequest();
  } else {
    signal?.addEventListener("abort", abortRequest, { once: true });
  }

  let timeoutId;
  const request = fetch(url, { signal: requestController.signal }).then(
    async (response) => {
      if (!response.ok) {
        throw new Error(`Hospital search returned HTTP ${response.status}.`);
      }
      return response.json();
    }
  );
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Hospital search timed out after ${timeoutMs} ms.`);
      error.name = "TimeoutError";
      requestController.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortRequest);
  }
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

export function bearingAtFraction(points, fraction, reverse = false) {
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

  const bearing = (degrees(Math.atan2(y, x)) + 360) % 360;
  return reverse ? (bearing + 180) % 360 : bearing;
}

export function pointBeforeEnd(points, distanceMeters = 1.5) {
  if (!points?.length) return [24.8607, 67.0011];
  if (points.length === 1) return points[0];

  const { total } = measureRoute(points);
  if (total <= 0) return points[points.length - 1];

  const offsetKm =
    Number.isFinite(distanceMeters) && distanceMeters > 0
      ? distanceMeters / 1000
      : 0;
  return pointAtFraction(
    points,
    Math.max(0, (total - offsetKm) / total)
  );
}

export function findRouteIntersections(routeA, routeB) {
  if (routeA?.length < 2 || routeB?.length < 2) return [];

  const sampleRoute = (points) => {
    const { total } = measureRoute(points);
    const endpointBufferKm = 0.3;
    if (total <= endpointBufferKm * 2) return [];

    const samples = [];
    for (
      let distance = endpointBufferKm;
      distance <= total - endpointBufferKm;
      distance += 0.025
    ) {
      const fraction = distance / total;
      samples.push({
        fraction,
        position: pointAtFraction(points, fraction),
        bearing: bearingAtFraction(points, fraction),
      });
    }
    return samples;
  };

  const samplesA = sampleRoute(routeA);
  const samplesB = sampleRoute(routeB);
  const intersections = [];
  const cellSizeKm = 0.018;
  const meanLatitude =
    [...routeA, ...routeB].reduce((sum, point) => sum + point[0], 0) /
    (routeA.length + routeB.length);
  const longitudeScale = 111.32 * Math.cos((meanLatitude * Math.PI) / 180);
  const cellFor = (position) => [
    Math.floor((position[1] * longitudeScale) / cellSizeKm),
    Math.floor((position[0] * 111.32) / cellSizeKm),
  ];
  const samplesByCell = new Map();
  for (const sample of samplesB) {
    const [cellX, cellY] = cellFor(sample.position);
    const cellKey = `${cellX}:${cellY}`;
    const cell = samplesByCell.get(cellKey) || [];
    cell.push(sample);
    samplesByCell.set(cellKey, cell);
  }

  for (const sampleA of samplesA) {
    let nearest = null;
    const [cellX, cellY] = cellFor(sampleA.position);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nearbySamples = samplesByCell.get(
          `${cellX + offsetX}:${cellY + offsetY}`
        );
        if (!nearbySamples) continue;

        for (const sampleB of nearbySamples) {
          const distanceMeters =
            distanceKm(sampleA.position, sampleB.position) * 1000;
          if (
            distanceMeters <= 18 &&
            (!nearest || distanceMeters < nearest.distanceMeters)
          ) {
            nearest = { sample: sampleB, distanceMeters };
          }
        }
      }
    }

    if (!nearest) continue;

    const angle = Math.abs(
      ((sampleA.bearing - nearest.sample.bearing + 540) % 360) - 180
    );
    if (angle < 25 || angle > 155) continue;

    const location = [
      (sampleA.position[0] + nearest.sample.position[0]) / 2,
      (sampleA.position[1] + nearest.sample.position[1]) / 2,
    ];
    if (
      intersections.some(
        (intersection) => distanceKm(intersection.location, location) < 0.1
      )
    ) {
      continue;
    }

    intersections.push({
      fractionA: sampleA.fraction,
      fractionB: nearest.sample.fraction,
      location,
      crossingAngleDegrees: angle,
      distanceMeters: nearest.distanceMeters,
    });
  }

  return intersections;
}

export function findVehicleCollisions(
  previousVehicles,
  currentVehicles,
  thresholdMeters = 9
) {
  if (!Array.isArray(previousVehicles) || !Array.isArray(currentVehicles)) {
    return [];
  }

  const previousById = new Map(
    previousVehicles.map((vehicle) => [vehicle.id, vehicle])
  );
  const collisions = [];

  for (let first = 0; first < currentVehicles.length; first += 1) {
    const currentA = currentVehicles[first];
    const previousA = previousById.get(currentA.id);
    if (!previousA?.position || !currentA.position) continue;

    for (let second = first + 1; second < currentVehicles.length; second += 1) {
      const currentB = currentVehicles[second];
      const previousB = previousById.get(currentB.id);
      if (!previousB?.position || !currentB.position) continue;

      for (let step = 0; step <= 16; step += 1) {
        const fraction = step / 16;
        const positionA = [
          previousA.position[0] +
            (currentA.position[0] - previousA.position[0]) * fraction,
          previousA.position[1] +
            (currentA.position[1] - previousA.position[1]) * fraction,
        ];
        const positionB = [
          previousB.position[0] +
            (currentB.position[0] - previousB.position[0]) * fraction,
          previousB.position[1] +
            (currentB.position[1] - previousB.position[1]) * fraction,
        ];
        const distanceMeters = distanceKm(positionA, positionB) * 1000;
        if (distanceMeters > thresholdMeters) continue;

        collisions.push({
          vehicleAId: currentA.id,
          vehicleBId: currentB.id,
          distanceMeters,
          location: [
            (positionA[0] + positionB[0]) / 2,
            (positionA[1] + positionB[1]) / 2,
          ],
        });
        break;
      }
    }
  }

  return collisions;
}

export function findVehicleCollisionsAlongInterval(
  getPositionsAtElapsed,
  startElapsed,
  endElapsed,
  { sampleIntervalMs = 50, thresholdMeters = 18 } = {}
) {
  if (
    typeof getPositionsAtElapsed !== "function" ||
    !Number.isFinite(startElapsed) ||
    !Number.isFinite(endElapsed) ||
    !Number.isFinite(sampleIntervalMs) ||
    sampleIntervalMs <= 0 ||
    !Number.isFinite(thresholdMeters) ||
    thresholdMeters < 0
  ) {
    throw new TypeError("Invalid vehicle collision interval.");
  }
  if (endElapsed <= startElapsed) return null;

  const sampleCount = Math.ceil(
    (endElapsed - startElapsed) / sampleIntervalMs
  );
  let previousPositions = getPositionsAtElapsed(startElapsed);
  for (let step = 1; step <= sampleCount; step += 1) {
    const timeElapsed =
      startElapsed + ((endElapsed - startElapsed) * step) / sampleCount;
    const currentPositions = getPositionsAtElapsed(timeElapsed);
    const collisions = findVehicleCollisions(
      previousPositions,
      currentPositions,
      thresholdMeters
    );
    if (collisions.length > 0) {
      return { collisions, currentPositions };
    }
    previousPositions = currentPositions;
  }

  return null;
}

export function normalizeNavigationRoutes(routes, routePrefix = "route") {
  if (!Array.isArray(routes)) {
    throw new Error("The routing service returned an invalid route list.");
  }

  const normalized = routes.flatMap((route, index) => {
    const rawCoordinates = route?.geometry?.coordinates;
    if (
      !Array.isArray(rawCoordinates) ||
      rawCoordinates.length < 2 ||
      rawCoordinates.some(
        (coordinate) => !Array.isArray(coordinate) || coordinate.length < 2
      ) ||
      !Number.isFinite(route.distance) ||
      route.distance < 0 ||
      !Number.isFinite(route.duration) ||
      route.duration < 0
    ) {
      return [];
    }

    const coordinates = rawCoordinates.map(([longitude, latitude]) => [
      latitude,
      longitude,
    ]);
    if (
      coordinates.some(
        ([latitude, longitude]) =>
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude) ||
          latitude < -90 ||
          latitude > 90 ||
          longitude < -180 ||
          longitude > 180
      )
    ) {
      return [];
    }

    return [
      {
        id: `${routePrefix}-${index}`,
        coordinates,
        distanceKm: route.distance / 1000,
        durationSeconds: route.duration,
      },
    ];
  });

  if (!normalized.length) {
    throw new Error("No usable road route was returned for these locations.");
  }
  return normalized;
}

export function parseNearbyHospitals(elements, accidentPoint) {
  if (!Array.isArray(elements)) return [];

  const uniqueHospitals = new Map();
  for (const item of elements) {
    if (!item || typeof item !== "object") continue;
    const latitude = item.lat ?? item.center?.lat;
    const longitude = item.lon ?? item.center?.lon;
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      continue;
    }

    const tags = item.tags || {};
    const address = [
      [tags["addr:housenumber"], tags["addr:street"]]
        .filter(Boolean)
        .join(" "),
      tags["addr:suburb"],
      tags["addr:city"],
    ]
      .filter(Boolean)
      .filter((part, index, parts) => parts.indexOf(part) === index)
      .join(", ");
    const name =
      typeof tags.name === "string" && tags.name.trim()
        ? tags.name.trim()
        : "Unnamed hospital";
    const elementId =
      item.id ?? `${latitude.toFixed(5)}-${longitude.toFixed(5)}`;
    const hospital = {
      id: `${item.type || "osm"}-${elementId}`,
      name,
      address,
      phone:
        typeof tags["contact:phone"] === "string"
          ? tags["contact:phone"]
          : typeof tags.phone === "string"
            ? tags.phone
            : "",
      lat: latitude,
      lon: longitude,
      distance: distanceKm(accidentPoint, [latitude, longitude]),
    };
    const key = `${name.toLowerCase()}-${latitude.toFixed(5)}-${longitude.toFixed(5)}`;
    if (!uniqueHospitals.has(key)) uniqueHospitals.set(key, hospital);
  }

  return [...uniqueHospitals.values()]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);
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
