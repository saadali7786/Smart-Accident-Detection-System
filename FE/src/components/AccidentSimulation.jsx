
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import {
  bearingAtFraction,
  buildRoutePair,
  distanceKm,
  findRouteIntersections,
  findVehicleCollisionsAlongInterval,
  fetchJsonWithTimeout,
  normalizeNavigationRoutes,
  parseNearbyHospitals,
  pointBeforeEnd,
  pointAtFraction,
} from "./accidentSimulationUtils";

const KARACHI_CENTER = [24.8607, 67.0011];
const COLLISION_INTERSECTION = {
  name: "NIPA Chowk",
  coordinates: [24.9179812, 67.0969429],
};
const ARRIVAL_BEARINGS = [135, 315];
const SIMULATION_DURATION_MS = 8500;
const SIMULATION_SPEED_OPTIONS_KMH = [5, 10, 20, 30, 40];
const DEFAULT_BACKEND_URL =
  import.meta.env.VITE_BACKEND_API_URL || "http://localhost:8080";
const DEFAULT_NOTIFICATION_URL =
  import.meta.env.VITE_NOTIFICATION_API_URL || "http://127.0.0.1:3001";

const LOCATIONS = [
  { name: "Clifton", lat: 24.8138, lon: 67.0305 },
  { name: "Saddar", lat: 24.8615, lon: 67.0099 },
  { name: "PECHS", lat: 24.8672, lon: 67.0622 },
  { name: "Gulshan-e-Iqbal", lat: 24.9263, lon: 67.0971 },
  { name: "North Nazimabad", lat: 24.9367, lon: 67.0382 },
  { name: "DHA", lat: 24.8015, lon: 67.0304 },
  { name: "Jinnah Airport", lat: 24.9065, lon: 67.1609 },
  { name: "NIPA", lat: 24.9206, lon: 67.0901 },
];
const DEFAULT_NAV_START = LOCATIONS.find(
  (location) => location.name === "Gulshan-e-Iqbal"
);
const DEFAULT_NAV_DESTINATION = LOCATIONS.find(
  (location) => location.name === "Saddar"
);
const NAVIGATION_PLAYBACK_MS = 45000;
const cardStyle = {
  background: "#111827",
  border: "1px solid #263449",
  borderRadius: 12,
  padding: 16,
  color: "#e5e7eb",
};
const buttonStyle = {
  border: 0,
  borderRadius: 8,
  padding: "11px 16px",
  fontWeight: 700,
  cursor: "pointer",
};

async function fetchRoadRoute(start, arrivalBearing) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${start.lon},${start.lat};${COLLISION_INTERSECTION.coordinates[1]},` +
    `${COLLISION_INTERSECTION.coordinates[0]}?overview=full&geometries=geojson&steps=false` +
    `&bearings=;${arrivalBearing},50`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error("Road routing service unavailable.");
  }

  const result = await response.json();
  if (result.code !== "Ok" || !result.routes?.length) {
    throw new Error(`Could not route a vehicle from ${start.name}.`);
  }

  return {
    start,
    distance: result.routes[0].distance / 1000,
    coordinates: result.routes[0].geometry.coordinates.map(
      ([lon, lat]) => [lat, lon]
    ),
  };
}

async function fetchNavigationRoutes(start, destination, signal) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${start.lon},${start.lat};${destination.lon},${destination.lat}` +
    "?alternatives=3&overview=full&geometries=geojson&steps=false";
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error("Road routing service unavailable.");
  }

  const result = await response.json();
  if (result.code !== "Ok" || !result.routes?.length) {
    throw new Error("No drivable route was found for these locations.");
  }

  return normalizeNavigationRoutes(
    result.routes,
    `${start.name}-${destination.name}`
  );
}

async function searchKarachiPlaces(query, signal) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("lat", String(KARACHI_CENTER[0]));
  url.searchParams.set("lon", String(KARACHI_CENTER[1]));
  url.searchParams.set("limit", "5");

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error("OpenStreetMap place search is unavailable.");
  }

  const result = await response.json();
  return (result.features || [])
    .map((feature) => {
      const [lon, lat] = feature.geometry?.coordinates || [];
      const properties = feature.properties || {};
      const name =
        properties.name ||
        properties.street ||
        properties.locality ||
        properties.city;
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

      const description = [
        properties.district,
        properties.city,
        properties.state,
      ]
        .filter((part, index, parts) => part && parts.indexOf(part) === index)
        .join(", ");

      return {
        name: description ? `${name}, ${description}` : name,
        lat,
        lon,
      };
    })
    .filter(Boolean);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error(`The service returned an invalid response (${response.status}).`);
  }

  if (!response.ok || result?.success === false) {
    throw new Error(
      result?.error || result?.message || `Request failed (${response.status}).`
    );
  }
  return result;
}

async function getJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
  });
  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error(`The service returned an invalid response (${response.status}).`);
  }

  if (!response.ok || result?.success === false) {
    throw new Error(
      result?.error || result?.message || `Request failed (${response.status}).`
    );
  }
  return result;
}

function LocationSearch({ label, place, onSelect, disabled = false }) {
  const [query, setQuery] = useState(place.name);
  const [suggestions, setSuggestions] = useState([]);
  const [searchState, setSearchState] = useState("idle");
  const [searchError, setSearchError] = useState("");

  useEffect(() => {
    setQuery(place.name);
    setSuggestions([]);
  }, [place.name]);

  useEffect(() => {
    const searchTerm = query.trim();
    if (searchTerm.length < 3 || searchTerm === place.name) {
      setSuggestions([]);
      setSearchState("idle");
      setSearchError("");
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearchState("searching");
      setSearchError("");
      try {
        const results = await searchKarachiPlaces(
          `${searchTerm}, Karachi`,
          controller.signal
        );
        setSuggestions(results);
        setSearchState(results.length ? "results" : "empty");
      } catch (error) {
        if (error.name !== "AbortError") {
          setSuggestions([]);
          setSearchError(error.message || "Place search failed.");
          setSearchState("error");
        }
      }
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [place.name, query]);

  const selectPlace = (result) => {
    onSelect(result);
    setQuery(result.name);
    setSuggestions([]);
    setSearchState("idle");
    setSearchError("");
  };

  return (
    <div style={{ position: "relative", minWidth: 220, flex: 1 }}>
      <label
        style={{
          display: "grid",
          gap: 6,
          color: "#b9c9dc",
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        {label}
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search a Karachi place"
          autoComplete="off"
          disabled={disabled}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            color: "#e5edf7",
            background: "#0b1420",
            border: "1px solid #3b5068",
            borderRadius: 8,
          }}
        />
      </label>
      {searchState === "searching" && (
        <small style={{ color: "#9bacbf" }}>Searching OpenStreetMap…</small>
      )}
      {searchError && (
        <small role="alert" style={{ color: "#fca5a5" }}>
          {searchError}
        </small>
      )}
      {searchState === "empty" && (
        <small style={{ color: "#9bacbf" }}>No matching places found.</small>
      )}
      {suggestions.length > 0 && (
        <div
          role="listbox"
          aria-label={`${label} search results`}
          style={{
            position: "absolute",
            zIndex: 1200,
            top: "100%",
            left: 0,
            right: 0,
            marginTop: 4,
            padding: 4,
            background: "#101b29",
            border: "1px solid #3b5068",
            borderRadius: 8,
            boxShadow: "0 8px 22px #0008",
          }}
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.name}-${index}`}
              type="button"
              role="option"
              aria-selected="false"
              disabled={disabled}
              onClick={() => selectPlace(suggestion)}
              style={{
                display: "block",
                width: "100%",
                padding: "9px 10px",
                color: "#e5edf7",
                textAlign: "left",
                background: "transparent",
                border: 0,
                borderRadius: 5,
                cursor: "pointer",
              }}
            >
              {suggestion.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const carIcon = (rotation = 0, vehicleType = "sedan", vehicleColor = "#f4f7fa") => {
  const isSuv = vehicleType === "suv";
  const width = isSuv ? 20 : 18;
  const height = isSuv ? 34 : 32;
  const html = `
    <div class="topdown-car" style="--car-color:${vehicleColor};transform:rotate(${rotation}deg)">
      <svg viewBox="0 0 20 34" width="${width}" height="${height}" aria-hidden="true">
        <path d="M6.7 2.2 Q10 1.1 13.3 2.2 L15.6 6.1 17.1 11.6 17.5 26.4 Q17.4 30.7 13.6 31.7 H6.4 Q2.6 30.7 2.5 26.4 L2.9 11.6 4.4 6.1 Z"
          fill="var(--car-color)" stroke="#263746" stroke-width="1.25"/>
        <path d="M4.6 9 Q5.1 6.1 7.6 5.8 H12.4 Q14.9 6.1 15.4 9 L16.1 12.1 H3.9 Z"
          fill="#253b4d" stroke="#a9bccb" stroke-opacity=".55" stroke-width=".6"/>
        <path d="M3.8 13.2 H16.2 L15.8 21.3 H4.2 Z" fill="#243746" opacity=".58"/>
        <path d="M4.5 23 H15.5 L14 27.1 H6 Z" fill="#314858" stroke="#8095a5" stroke-opacity=".55" stroke-width=".55"/>
        <path d="M1.8 9.5 H3 V13.1 H1.7 M17 9.5 H18.2 L18.3 13.1 H17"
          fill="#17232e" stroke="#182632" stroke-width=".5"/>
        <path d="M1.8 23 H3 V26.6 H1.7 M17 23 H18.2 L18.3 26.6 H17"
          fill="#17232e" stroke="#182632" stroke-width=".5"/>
        <path d="M5.2 3.6 Q10 2.3 14.8 3.6" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width=".7"/>
      </svg>
    </div>`;

  return L.divIcon({
    className: "simulation-marker vehicle-marker navigation-vehicle-marker topdown-car-icon",
    html,
    iconSize: [width, height],
    iconAnchor: [width / 2, height / 2],
  });
};

const hospitalIcon = L.divIcon({
  className: "simulation-marker",
  html: `<div style="
    width:30px;height:30px;border-radius:50%;background:#dc2626;
    border:2px solid white;color:white;display:flex;align-items:center;
    justify-content:center;font-size:19px;font-weight:900;
    box-shadow:0 2px 8px #0008;">✚</div>`,
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

const accidentIcon = L.divIcon({
  className: "simulation-marker",
  html: `<div class="accident-pulse" style="
    width:30px;height:30px;border-radius:50%;background:#dc2626;
    border:3px solid white;color:white;display:flex;align-items:center;
    justify-content:center;font-size:17px;font-weight:800;
    box-shadow:0 2px 8px #0008;">!</div>`,
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

const impactIcon = L.divIcon({
  className: "simulation-marker",
  html: '<div class="collision-impact" aria-hidden="true"></div>',
  iconSize: [56, 56],
  iconAnchor: [28, 28],
});

function FitRoute({ coordinates }) {
  const map = useMap();

  useEffect(() => {
    if (coordinates?.length > 1) {
      map.fitBounds(coordinates, { padding: [45, 45] });
    }
  }, [coordinates, map]);

  return null;
}

function getTrafficRouteCandidates(startPlace, destinationPlace) {
  const candidates = [];
  for (let startIndex = 0; startIndex < LOCATIONS.length; startIndex += 1) {
    for (
      let destinationIndex = 0;
      destinationIndex < LOCATIONS.length;
      destinationIndex += 1
    ) {
      if (startIndex === destinationIndex) continue;
      const start = LOCATIONS[startIndex];
      const destination = LOCATIONS[destinationIndex];
      const distance = distanceKm(
        [start.lat, start.lon],
        [destination.lat, destination.lon]
      );
      if (distance < 3) continue;
      if (
        distanceKm(
          [start.lat, start.lon],
          [startPlace.lat, startPlace.lon]
        ) < 0.3 &&
        distanceKm(
          [destination.lat, destination.lon],
          [destinationPlace.lat, destinationPlace.lon]
        ) < 0.3
      ) {
        continue;
      }
      candidates.push({ start, destination });
    }
  }
  return candidates.sort(() => Math.random() - 0.5);
}

function areTrafficRoutesDistinct(first, second) {
  const firstStart = first.coordinates[0];
  const firstEnd = first.coordinates.at(-1);
  const secondStart = second.coordinates[0];
  const secondEnd = second.coordinates.at(-1);
  const sameDirection =
    distanceKm(firstStart, secondStart) < 0.15 &&
    distanceKm(firstEnd, secondEnd) < 0.15;
  const reverseDirection =
    distanceKm(firstStart, secondEnd) < 0.15 &&
    distanceKm(firstEnd, secondStart) < 0.15;
  if (!sameDirection && !reverseDirection) return true;

  const firstMiddle = pointAtFraction(first.coordinates, 0.5);
  const secondMiddle = pointAtFraction(second.coordinates, 0.5);
  return (
    distanceKm(firstMiddle, secondMiddle) > 0.08 ||
    Math.abs(first.distanceKm - second.distanceKm) > 0.15
  );
}

function createTrafficFleet(routes, intersection) {
  const colors = ["#256b9d", "#a83f3f", "#3b7052", "#a77a2d"];
  const vehicles = [];
  const addVehicle = (
    id,
    routeIndex,
    startFraction,
    endFraction,
    delayFraction,
    type,
  ) => {
    vehicles.push({
      id,
      routeIndex,
      startFraction,
      endFraction,
      delayFraction,
      type,
      color: colors[vehicles.length % colors.length],
    });
  };

  if (intersection && routes.length > 1) {
    const directionOptions = [];
    for (const reverseA of [false, true]) {
      for (const reverseB of [false, true]) {
        const crossingA = reverseA
          ? 1 - intersection.fractionA
          : intersection.fractionA;
        const crossingB = reverseB
          ? 1 - intersection.fractionB
          : intersection.fractionB;
        const startA = routes[intersection.routeIndexA].coordinates[
          reverseA ? routes[intersection.routeIndexA].coordinates.length - 1 : 0
        ];
        const startB = routes[intersection.routeIndexB].coordinates[
          reverseB ? routes[intersection.routeIndexB].coordinates.length - 1 : 0
        ];
        if (distanceKm(startA, startB) < 0.25) continue;

        const target = Math.max(crossingA, crossingB);
        const delayA =
          (target - crossingA) / Math.max(0.001, 1 - crossingA);
        const delayB =
          (target - crossingB) / Math.max(0.001, 1 - crossingB);
        directionOptions.push({
          reverseA,
          reverseB,
          crossingA,
          crossingB,
          delayA,
          delayB,
          score: delayA + delayB + target * 0.25,
        });
      }
    }
    directionOptions.sort((first, second) => first.score - second.score);
    const direction = directionOptions[0] || {
      reverseA: false,
      reverseB: true,
      crossingA: intersection.fractionA,
      crossingB: 1 - intersection.fractionB,
      delayA: 0,
      delayB: 0,
    };

    const delayForCrossing = (crossingProgress) =>
      (Math.max(direction.crossingA, direction.crossingB) - crossingProgress) /
      Math.max(0.001, 1 - crossingProgress);
    addVehicle(
      "SIM-CAR-01",
      intersection.routeIndexA,
      direction.reverseA ? 1 : 0,
      direction.reverseA ? 0 : 1,
      delayForCrossing(direction.crossingA),
      "sedan"
    );
    addVehicle(
      "SIM-CAR-02",
      intersection.routeIndexB,
      direction.reverseB ? 1 : 0,
      direction.reverseB ? 0 : 1,
      delayForCrossing(direction.crossingB),
      "suv"
    );
  }

  const unusedRouteIndexes = routes
    .map((_, index) => index)
    .filter(
      (index) =>
        !intersection ||
        (index !== intersection.routeIndexA &&
          index !== intersection.routeIndexB)
    );
  while (vehicles.length < 4) {
    const vehicleIndex = vehicles.length;
    const routeIndex =
      unusedRouteIndexes.length > 0
        ? unusedRouteIndexes.shift()
        : vehicleIndex % routes.length;
    const reverse = vehicleIndex % 2 === 1;
    addVehicle(
      `SIM-CAR-0${vehicleIndex + 1}`,
      routeIndex,
      reverse ? 0.92 : 0.08,
      reverse ? 0.08 : 0.92,
      0.08,
      vehicleIndex % 2 === 1 ? "suv" : "sedan"
    );
  }

  return vehicles;
}

function MultiVehicleTraffic({
  startPlace,
  destinationPlace,
  onSelectPlace,
  simulationSpeedKmh,
  setSimulationSpeedKmh,
  sendDemoAlerts,
  setSendDemoAlerts,
  onCollisionDetected,
  onRunningChange,
  incident,
  classification,
  incidentSaveState,
  hospitalStatus,
  hospitalError,
  hospitals,
  hospitalRouteStatus,
  hospitalRoute,
  hospitalRouteError,
  notificationDelivery,
  onRetryNotification,
}) {
  const [trafficRoutes, setTrafficRoutes] = useState([]);
  const [trafficFleet, setTrafficFleet] = useState([]);
  const [intersection, setIntersection] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [runStatus, setRunStatus] = useState("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [collisionEvents, setCollisionEvents] = useState([]);
  const [crashedVehicles, setCrashedVehicles] = useState(new Set());
  const [trafficPlaybackDuration, setTrafficPlaybackDuration] = useState(35000);
  const routeRequestIdRef = useRef(0);
  const previousElapsedRef = useRef(null);
  const reportedPairsRef = useRef(new Set());
  const crashedPositionsRef = useRef(new Map());
  const runStartRef = useRef(0);

  const loadTrafficRoutes = useCallback(async () => {
    const requestId = routeRequestIdRef.current + 1;
    routeRequestIdRef.current = requestId;
    setRouteLoading(true);
    setRouteError("");
    setTrafficRoutes([]);
    setTrafficFleet([]);
    setIntersection(null);
    setRunStatus("idle");
    setElapsedMs(0);
    onRunningChange(false);

    try {
      const primaryRoutes = await fetchNavigationRoutes(
        startPlace,
        destinationPlace
      );
      const distinctRoutes = [];
      primaryRoutes.forEach((route, index) => {
        if (
          distinctRoutes.length < 4 &&
          distinctRoutes.every((existing) =>
            areTrafficRoutesDistinct(existing, route)
          )
        ) {
          distinctRoutes.push({
            ...route,
            label:
              index === 0
                ? `${startPlace.name} → ${destinationPlace.name}`
                : `${startPlace.name} → ${destinationPlace.name} · Alternative ${index}`,
          });
        }
      });

      if (distinctRoutes.length < 4) {
        const candidates = getTrafficRouteCandidates(
          startPlace,
          destinationPlace
        ).slice(0, 4 - distinctRoutes.length);
        const results = await Promise.allSettled(
          candidates.map(async ({ start, destination }) => ({
            start,
            destination,
            routes: await fetchNavigationRoutes(start, destination),
          }))
        );
        results.forEach((result) => {
          if (result.status !== "fulfilled" || distinctRoutes.length >= 4) {
            return;
          }
          const route = result.value.routes[0];
          if (
            route &&
            distinctRoutes.every((existing) =>
              areTrafficRoutesDistinct(existing, route)
            )
          ) {
            distinctRoutes.push({
              ...route,
              label: `${result.value.start.name} → ${result.value.destination.name}`,
            });
          }
        });
      }

      if (requestId !== routeRequestIdRef.current) return;
      if (distinctRoutes.length === 0) {
        throw new Error("No road routes were available for the traffic simulation.");
      }

      const intersections = [];
      for (let first = 0; first < distinctRoutes.length; first += 1) {
        for (let second = first + 1; second < distinctRoutes.length; second += 1) {
          findRouteIntersections(
            distinctRoutes[first].coordinates,
            distinctRoutes[second].coordinates
          ).forEach((crossing) => {
            intersections.push({
              ...crossing,
              routeIndexA: first,
              routeIndexB: second,
            });
          });
        }
      }
      const selectedIntersection =
        intersections[Math.floor(Math.random() * intersections.length)] || null;

      setTrafficRoutes(distinctRoutes);
      setIntersection(selectedIntersection);
      setTrafficFleet(createTrafficFleet(distinctRoutes, selectedIntersection));
      if (distinctRoutes.length < 2) {
        setRouteError(
          "Only one distinct route was available. Vehicles can still follow it, but road-to-road collisions require more route data."
        );
      } else if (!selectedIntersection) {
        setRouteError(
          "No route crossing was found in the loaded road geometries. Vehicles will move normally; collisions are recorded only if their positions actually meet."
        );
      }
    } catch (loadError) {
      if (requestId === routeRequestIdRef.current) {
        setRouteError(
          loadError.message || "Could not load real road geometry for traffic."
        );
      }
    } finally {
      if (requestId === routeRequestIdRef.current) setRouteLoading(false);
    }
  }, [destinationPlace, onRunningChange, startPlace]);

  useEffect(() => {
    void loadTrafficRoutes();
    return () => {
      routeRequestIdRef.current += 1;
    };
  }, [loadTrafficRoutes]);

  const getVehiclePositionsAtElapsed = useCallback(
    (timeElapsed) =>
      trafficFleet.map((vehicle) => {
        const route = trafficRoutes[vehicle.routeIndex];
        const startedAt = vehicle.delayFraction * trafficPlaybackDuration;
        const remainingDuration = Math.max(
          1,
          trafficPlaybackDuration - startedAt
        );
        const routeProgress = Math.min(
          1,
          Math.max(0, (timeElapsed - startedAt) / remainingDuration)
        );
        const routeFraction =
          vehicle.startFraction +
          (vehicle.endFraction - vehicle.startFraction) * routeProgress;
        const frozenPosition = crashedPositionsRef.current.get(vehicle.id);
        const position =
          frozenPosition || pointAtFraction(route.coordinates, routeFraction);
        const heading = bearingAtFraction(
          route.coordinates,
          routeFraction,
          vehicle.endFraction < vehicle.startFraction
        );

        return {
          ...vehicle,
          route,
          routeFraction,
          position,
          heading,
          moving:
            runStatus === "running" &&
            timeElapsed >= startedAt &&
            routeProgress < 1 &&
            !crashedVehicles.has(vehicle.id),
          crashed: crashedVehicles.has(vehicle.id),
        };
      }),
    [
      crashedVehicles,
      runStatus,
      trafficFleet,
      trafficPlaybackDuration,
      trafficRoutes,
    ]
  );

  const vehiclePositions = useMemo(
    () => getVehiclePositionsAtElapsed(elapsedMs),
    [elapsedMs, getVehiclePositionsAtElapsed]
  );

  const findCollisionsAcrossElapsed = useCallback(
    (startElapsed, endElapsed) => {
      return findVehicleCollisionsAlongInterval(
        getVehiclePositionsAtElapsed,
        startElapsed,
        endElapsed,
        {
          sampleIntervalMs: 50,
          thresholdMeters: 18,
        }
      );
    },
    [getVehiclePositionsAtElapsed]
  );

  const registerCollisions = useCallback(
    (collisions, currentVehicles) => {
      collisions.forEach((collision) => {
        const pairKey = [collision.vehicleAId, collision.vehicleBId]
          .sort()
          .join(":");
        if (reportedPairsRef.current.has(pairKey)) return;
        reportedPairsRef.current.add(pairKey);
        crashedPositionsRef.current.set(
          collision.vehicleAId,
          collision.location
        );
        crashedPositionsRef.current.set(
          collision.vehicleBId,
          collision.location
        );
        setCrashedVehicles((current) => {
          const updated = new Set(current);
          updated.add(collision.vehicleAId);
          updated.add(collision.vehicleBId);
          return updated;
        });

        const vehicleA = currentVehicles.find(
          (vehicle) => vehicle.id === collision.vehicleAId
        );
        const vehicleB = currentVehicles.find(
          (vehicle) => vehicle.id === collision.vehicleBId
        );
        const headingDifference = Math.abs(
          ((vehicleA.heading - vehicleB.heading + 540) % 360) - 180
        );
        const collisionType =
          headingDifference >= 135
            ? "head-on"
            : headingDifference >= 45
              ? "side-impact"
              : "rear-end";
        const incidentEvent = {
          eventId: `traffic-${crypto.randomUUID()}`,
          timestamp: new Date().toISOString(),
          latitude: Number(collision.location[0].toFixed(6)),
          longitude: Number(collision.location[1].toFixed(6)),
          mapsUrl: `https://www.google.com/maps?q=${collision.location[0]},${collision.location[1]}`,
          type: "SIMULATED VEHICLE COLLISION",
          vehicleAId: collision.vehicleAId,
          vehicleBId: collision.vehicleBId,
          collisionType,
          speedA: simulationSpeedKmh,
          speedB: simulationSpeedKmh,
          routeA: vehicleA?.route?.label,
          routeB: vehicleB?.route?.label,
        };
        setCollisionEvents((current) => [
          { ...incidentEvent, processingStatus: "Submitting to C++ backend" },
          ...current,
        ]);
        Promise.resolve(onCollisionDetected(incidentEvent)).then(
          (result) => {
            setCollisionEvents((current) =>
              current.map((event) =>
                event.eventId === incidentEvent.eventId
                  ? {
                      ...event,
                      accidentId: result?.accidentId,
                      severity: result?.severity,
                      impactScore: result?.impactScore,
                      processingStatus: result
                        ? result.processingStatus || "Processed by C++ backend"
                        : "Backend processing failed",
                    }
                  : event
              )
            );
          },
          (processingError) => {
            setCollisionEvents((current) =>
              current.map((event) =>
                event.eventId === incidentEvent.eventId
                  ? {
                      ...event,
                      processingStatus:
                        processingError.message || "Backend processing failed",
                    }
                  : event
              )
            );
          }
        );
      });
    },
    [onCollisionDetected, simulationSpeedKmh]
  );

  useEffect(() => {
    if (runStatus !== "running" || !trafficRoutes.length) {
      previousElapsedRef.current = null;
      return;
    }
    if (elapsedMs === 0 || previousElapsedRef.current === null) {
      previousElapsedRef.current = elapsedMs;
      return;
    }

    const detection = findCollisionsAcrossElapsed(
      previousElapsedRef.current,
      elapsedMs
    );
    if (detection) {
      registerCollisions(detection.collisions, detection.currentPositions);
    }
    previousElapsedRef.current = elapsedMs;
  }, [
    elapsedMs,
    findCollisionsAcrossElapsed,
    registerCollisions,
    runStatus,
    trafficRoutes.length,
  ]);

  useEffect(() => {
    if (runStatus !== "running") return undefined;
    let frameId;
    const animate = (now) => {
      const nextElapsed = Math.min(
        trafficPlaybackDuration,
        now - runStartRef.current
      );
      if (nextElapsed >= trafficPlaybackDuration) {
        if (previousElapsedRef.current !== null) {
          const detection = findCollisionsAcrossElapsed(
            previousElapsedRef.current,
            nextElapsed
          );
          if (detection) {
            registerCollisions(
              detection.collisions,
              detection.currentPositions
            );
          }
        }
        previousElapsedRef.current = nextElapsed;
        setElapsedMs(nextElapsed);
        setRunStatus("completed");
        onRunningChange(false);
        return;
      }
      setElapsedMs(nextElapsed);
      frameId = window.requestAnimationFrame(animate);
    };
    frameId = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frameId);
  }, [
    onRunningChange,
    findCollisionsAcrossElapsed,
    registerCollisions,
    runStatus,
    trafficPlaybackDuration,
  ]);

  const startTraffic = () => {
    if (trafficRoutes.length === 0) return;
    reportedPairsRef.current.clear();
    crashedPositionsRef.current.clear();
    previousElapsedRef.current = null;
    setCollisionEvents([]);
    setCrashedVehicles(new Set());
    setElapsedMs(0);
    setTrafficPlaybackDuration(35000 / playbackSpeed);
    runStartRef.current = performance.now();
    setRunStatus("running");
    onRunningChange(true);
  };

  const pauseTraffic = () => {
    setRunStatus("paused");
    onRunningChange(false);
  };

  const resumeTraffic = () => {
    runStartRef.current = performance.now() - elapsedMs;
    setRunStatus("running");
    onRunningChange(true);
  };

  const resetTraffic = () => {
    setRunStatus("idle");
    setElapsedMs(0);
    setCollisionEvents([]);
    setCrashedVehicles(new Set());
    crashedPositionsRef.current.clear();
    reportedPairsRef.current.clear();
    previousElapsedRef.current = null;
    onRunningChange(false);
  };

  const mapBounds = useMemo(
    () => trafficRoutes.flatMap((route) => route.coordinates),
    [trafficRoutes]
  );

  return (
    <div className="traffic-page">
      <div className="traffic-location-controls">
        <LocationSearch
          label="Starting location"
          place={startPlace}
          onSelect={(place) => onSelectPlace("start", place)}
          disabled={runStatus === "running"}
        />
        <LocationSearch
          label="Destination"
          place={destinationPlace}
          onSelect={(place) => onSelectPlace("destination", place)}
          disabled={runStatus === "running"}
        />
        <button
          type="button"
          className="traffic-build-route"
          disabled={routeLoading || runStatus === "running"}
          onClick={() => void loadTrafficRoutes()}
        >
          {routeLoading ? "Loading routes…" : "Update routes"}
        </button>
        <span
          className="traffic-demo-badge"
          title="Vehicle positions are simulated from road geometry; this is not live GPS."
        >
          DEMO · Simulated GPS
        </span>
      </div>

      {routeError && (
        <div className="traffic-route-error" role="alert">
          {routeError}
        </div>
      )}
      <section className="traffic-map-card" aria-label="Karachi multi-vehicle traffic map">
        <div className="traffic-map-frame">
          <MapContainer
            center={[startPlace.lat, startPlace.lon]}
            zoom={12}
            style={{ height: "100%", width: "100%" }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {mapBounds.length > 1 && <FitRoute coordinates={mapBounds} />}
            {[...trafficRoutes.slice(1), ...trafficRoutes.slice(0, 1)].flatMap(
              (route) => {
                const selected = route.id === trafficRoutes[0]?.id;
                return [
                  <Polyline
                    key={`${route.id}-casing`}
                    positions={route.coordinates}
                    pathOptions={{
                      color: "#fff",
                      weight: selected ? 10 : 8,
                      opacity: 0.92,
                      lineCap: "round",
                      lineJoin: "round",
                    }}
                  />,
                  <Polyline
                    key={route.id}
                    positions={route.coordinates}
                    pathOptions={{
                      color: selected ? "#2478f2" : "#1c9a58",
                      weight: selected ? 6 : 4,
                      opacity: selected ? 1 : 0.94,
                      lineCap: "round",
                      lineJoin: "round",
                    }}
                  >
                    <Popup>
                      {selected ? "Selected route" : "Alternative route"}:{" "}
                      {route.label} · {route.distanceKm.toFixed(1)} km
                    </Popup>
                  </Polyline>,
                ];
              }
            )}
            <CircleMarker
              center={[startPlace.lat, startPlace.lon]}
              radius={6}
              pathOptions={{
                color: "#fff",
                fillColor: "#159447",
                fillOpacity: 1,
                weight: 2,
              }}
            >
              <Popup>Start: {startPlace.name}</Popup>
            </CircleMarker>
            <CircleMarker
              center={[destinationPlace.lat, destinationPlace.lon]}
              radius={6}
              pathOptions={{
                color: "#fff",
                fillColor: "#e45d4f",
                fillOpacity: 1,
                weight: 2,
              }}
            >
              <Popup>Destination: {destinationPlace.name}</Popup>
            </CircleMarker>
            {incident && hospitalRouteStatus === "ready" && hospitalRoute && (
              <Polyline
                positions={hospitalRoute.coordinates}
                pathOptions={{
                  color: "#d97706",
                  weight: 4,
                  opacity: 0.88,
                  dashArray: "7 8",
                }}
              />
            )}
            {incident &&
              hospitals.map((hospital) => (
                <Marker
                  key={hospital.id}
                  position={[hospital.lat, hospital.lon]}
                  icon={hospitalIcon}
                >
                  <Popup>
                    {hospital.name} · {hospital.distance.toFixed(2)} km
                    <br />
                    OSM listing; phone numbers are not independently verified.
                  </Popup>
                </Marker>
              ))}
            {vehiclePositions.map((vehicle) => (
              <Marker
                key={vehicle.id}
                position={vehicle.position}
                icon={carIcon(vehicle.heading, vehicle.type, vehicle.color)}
                zIndexOffset={vehicle.crashed ? 1700 : 1200}
                keyboard={false}
              >
                <Popup>
                  {vehicle.id} ·{" "}
                  {vehicle.crashed
                    ? "Collision stopped"
                    : vehicle.moving
                      ? "Moving"
                      : "On route"}
                  <br />
                  {vehicle.route?.label}
                </Popup>
              </Marker>
            ))}
            {collisionEvents.map((event) => (
              <Marker
                key={event.eventId}
                position={[event.latitude, event.longitude]}
                icon={accidentIcon}
                zIndexOffset={1900}
              >
                <Popup>
                  Collision · {event.accidentId || event.eventId}
                  <br />
                  {event.severity || "Backend classification pending"}
                </Popup>
              </Marker>
            ))}
          </MapContainer>

          <div className="traffic-map-live-status" role="status" aria-live="polite">
            <span>{trafficFleet.length} vehicles</span>
            <span>
              {Math.round(
                (elapsedMs / Math.max(trafficPlaybackDuration, 1)) * 100
              )}
              % route
            </span>
            <span>{collisionEvents.length} collisions</span>
          </div>

          <div className="traffic-map-controls" aria-label="Traffic simulation controls">
            <button
              type="button"
              className="traffic-control-button traffic-control-start"
              disabled={!trafficRoutes.length || routeLoading || runStatus === "running"}
              onClick={startTraffic}
            >
              {runStatus === "completed" ? "Run again" : "Start"}
            </button>
            <button
              type="button"
              className="traffic-control-button"
              disabled={runStatus !== "running"}
              onClick={pauseTraffic}
            >
              Pause
            </button>
            <button
              type="button"
              className="traffic-control-button"
              disabled={runStatus !== "paused"}
              onClick={resumeTraffic}
            >
              Resume
            </button>
            <button
              type="button"
              className="traffic-control-button"
              disabled={runStatus === "idle"}
              onClick={resetTraffic}
            >
              Reset
            </button>
            <label className="traffic-select-control">
              Speed
              <select
                aria-label="Playback speed"
                value={playbackSpeed}
                onChange={(event) => setPlaybackSpeed(Number(event.target.value))}
                disabled={runStatus === "running"}
              >
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
                <option value={2}>2×</option>
              </select>
            </label>
            <label className="traffic-select-control traffic-score-control">
              Impact input
              <select
                aria-label="C++ demo impact input"
                value={simulationSpeedKmh}
                onChange={(event) =>
                  setSimulationSpeedKmh(Number(event.target.value))
                }
                disabled={runStatus === "running"}
                title="Demo score input only; not vehicle sensor telemetry."
              >
                {SIMULATION_SPEED_OPTIONS_KMH.map((speed) => (
                  <option key={speed} value={speed}>
                    {speed} km/h
                  </option>
                ))}
              </select>
            </label>
            <label
              className="traffic-demo-alert-control"
              title="Only configured demo recipients may receive test alerts. Hospitals are never messaged."
            >
              <input
                type="checkbox"
                aria-label="Allow configured DEMO SMS after a Severe classification. No hospital or real emergency contacts are messaged."
                checked={sendDemoAlerts}
                onChange={(event) => setSendDemoAlerts(event.target.checked)}
                disabled={runStatus === "running"}
              />
              DEMO SMS
            </label>
          </div>

          <div className="traffic-map-legend" aria-label="Map route legend">
            <span><i className="traffic-legend-line selected" />Selected route</span>
            <span><i className="traffic-legend-line alternative" />Alternative</span>
            {incident && hospitalRouteStatus === "ready" && (
              <span><i className="traffic-legend-line hospital" />Hospital route</span>
            )}
          </div>
        </div>
      </section>

      {incident && (
        <section className="traffic-response-card" aria-live="polite">
          <div className="traffic-response-summary">
            <div className="traffic-response-title">
              <strong>Accident detected</strong>
              <span>{classification?.severity || "Classification pending"}</span>
            </div>
            <div className="traffic-response-facts">
              <span>
                <small>Accident</small>
                {classification?.accidentId
                  ? `#${classification.accidentId}`
                  : "Pending"}
              </span>
              <span>
                <small>Impact score</small>
                {classification?.impactScore ?? "Pending"}
              </span>
              <span>
                <small>Location</small>
                {incident.latitude.toFixed(5)}, {incident.longitude.toFixed(5)}
              </span>
              <span>
                <small>Processing</small>
                {classification?.processingStatus ||
                  incidentSaveState.message ||
                  incidentSaveState.status}
              </span>
            </div>
            <a
              className="traffic-map-link"
              href={incident.mapsUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open location
            </a>
          </div>
          {notificationDelivery && (
            <p className="traffic-notification-status" role="status">
              DEMO SMS · {notificationDelivery.status}:{" "}
              {notificationDelivery.message}
              {notificationDelivery.status === "error" && (
                <button type="button" onClick={onRetryNotification}>
                  Retry
                </button>
              )}
            </p>
          )}
          <details className="traffic-response-details">
            <summary>
              Nearby hospitals ·{" "}
              {hospitalStatus === "loading"
                ? "Searching"
                : hospitalStatus === "error"
                  ? "Unavailable"
                  : hospitals.length
                    ? `${hospitals.length} found`
                    : "Details"}
            </summary>
            {hospitalStatus === "loading" && <p>Searching OpenStreetMap…</p>}
            {hospitalStatus === "error" && <p role="alert">{hospitalError}</p>}
            {hospitalStatus === "complete" && hospitals.length === 0 && (
              <p>No hospitals found in the current OpenStreetMap results.</p>
            )}
            {hospitalRouteStatus === "loading" && <p>Finding hospital road route…</p>}
            {hospitalRouteStatus === "ready" && hospitalRoute && (
              <p>
                Road route: {hospitalRoute.distanceKm.toFixed(2)} km · about{" "}
                {Math.max(1, Math.round(hospitalRoute.durationSeconds / 60))} min
                {" "}(no live traffic).
              </p>
            )}
            {hospitalRouteStatus === "error" && <p role="alert">{hospitalRouteError}</p>}
            {hospitals.map((hospital) => (
              <div key={hospital.id} className="traffic-hospital-row">
                <strong>{hospital.name}</strong>
                <span>{hospital.distance.toFixed(2)} km</span>
                {hospital.address && <small>{hospital.address}</small>}
                {hospital.phone && (
                  <small>OSM-listed phone (not verified): {hospital.phone}</small>
                )}
                <a
                  href={`https://www.google.com/maps?q=${hospital.lat},${hospital.lon}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Map
                </a>
              </div>
            ))}
            <p className="traffic-response-note">
              Demo coordinates are map-derived, not live GPS. No hospital is messaged.
            </p>
          </details>
        </section>
      )}
    </div>
  );
}

export default function AccidentSimulation({
  backendUrl = DEFAULT_BACKEND_URL,
  notificationUrl = DEFAULT_NOTIFICATION_URL,
  onIncidentSaved,
}) {
  const [mode, setMode] = useState("traffic");
  const [trafficRunning, setTrafficRunning] = useState(false);
  const [startPlace, setStartPlace] = useState(DEFAULT_NAV_START);
  const [destinationPlace, setDestinationPlace] = useState(
    DEFAULT_NAV_DESTINATION
  );
  const [navigationRoutes, setNavigationRoutes] = useState([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [navigationStatus, setNavigationStatus] = useState("idle");
  const [navigationProgress, setNavigationProgress] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [navigationLoading, setNavigationLoading] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const [routes, setRoutes] = useState(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("idle");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [incident, setIncident] = useState(null);
  const [hospitals, setHospitals] = useState([]);
  const [hospitalStatus, setHospitalStatus] = useState("idle");
  const [hospitalError, setHospitalError] = useState("");
  const [hospitalRoute, setHospitalRoute] = useState(null);
  const [hospitalRouteStatus, setHospitalRouteStatus] = useState("idle");
  const [hospitalRouteError, setHospitalRouteError] = useState("");
  const [simulationSpeedKmh, setSimulationSpeedKmh] = useState(40);
  const [incidentSaveState, setIncidentSaveState] = useState({
    status: "idle",
    message: "",
  });
  const [classification, setClassification] = useState(null);
  const [notificationDelivery, setNotificationDelivery] = useState(null);
  const [sendDemoAlerts, setSendDemoAlerts] = useState(false);
  const collisionHandledRef = useRef(false);
  const savePendingRef = useRef(new Set());
  const savePromisesRef = useRef(new Map());
  const latestIncidentRef = useRef(null);
  const notificationAttemptsRef = useRef(new Set());
  const notificationPendingRef = useRef(new Set());
  const notificationSentRef = useRef(new Set());
  const navigationProgressRef = useRef(0);
  const initialNavigationLoadRef = useRef(false);
  const hospitalControllersRef = useRef(new Map());

  const loadNavigationRoutes = useCallback(async () => {
    setNavigationLoading(true);
    setNavigationError("");
    setNavigationRoutes([]);
    setSelectedRouteIndex(0);
    setNavigationStatus("idle");
    navigationProgressRef.current = 0;
    setNavigationProgress(0);

    try {
      const foundRoutes = await fetchNavigationRoutes(
        startPlace,
        destinationPlace
      );
      setNavigationRoutes(foundRoutes);
      setNavigationStatus("ready");
    } catch (routeError) {
      setNavigationError(
        routeError.message || "Could not load a road route for these locations."
      );
    } finally {
      setNavigationLoading(false);
    }
  }, [destinationPlace, startPlace]);

  const loadRandomRoute = useCallback(async () => {
    setLoading(true);
    setError("");
    setStatus("idle");
    setProgress(0);
    setRoutes(null);
    setIncident(null);
    setHospitals([]);
    setHospitalStatus("idle");
    setHospitalError("");
    setHospitalRoute(null);
    setHospitalRouteStatus("idle");
    setHospitalRouteError("");
    setIncidentSaveState({ status: "idle", message: "" });
    setClassification(null);
    setNotificationDelivery(null);
    collisionHandledRef.current = false;

    try {
      const starts = LOCATIONS.filter(
        (location) =>
          distanceKm(
            [location.lat, location.lon],
            COLLISION_INTERSECTION.coordinates
          ) > 2
      );
      const candidatePairs = [];
      for (let first = 0; first < starts.length; first += 1) {
        for (let second = first + 1; second < starts.length; second += 1) {
          if (
            distanceKm(
              [starts[first].lat, starts[first].lon],
              [starts[second].lat, starts[second].lon]
            ) > 2
          ) {
            candidatePairs.push([starts[first], starts[second]]);
          }
        }
      }

      candidatePairs.sort(() => Math.random() - 0.5);
      let selectedRoutes = null;
      let routePairError = null;

      for (const [startA, startB] of candidatePairs.slice(0, 4)) {
        const [routeA, routeB] = await Promise.all([
          fetchRoadRoute(startA, ARRIVAL_BEARINGS[0]),
          fetchRoadRoute(startB, ARRIVAL_BEARINGS[1]),
        ]);
        try {
          selectedRoutes = buildRoutePair(
            routeA,
            routeB,
            COLLISION_INTERSECTION.coordinates
          );
          break;
        } catch (routeError) {
          routePairError = routeError;
        }
      }

      if (!selectedRoutes) {
        throw routePairError || new Error("Could not find two distinct road approaches.");
      }

      setRoutes({
        ...selectedRoutes,
        intersection: COLLISION_INTERSECTION,
        totalDistance:
          selectedRoutes.vehicleA.distance + selectedRoutes.vehicleB.distance,
        coordinates: [
          ...selectedRoutes.vehicleA.coordinates,
          ...selectedRoutes.vehicleB.coordinates,
        ],
      });
    } catch (err) {
      setError(err.message || "Could not load the Karachi road route.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === "navigation" && !initialNavigationLoadRef.current) {
      initialNavigationLoadRef.current = true;
      void loadNavigationRoutes();
    }
    if (mode === "simulation") {
      void loadRandomRoute();
    }
  }, [loadNavigationRoutes, loadRandomRoute, mode]);

  const activeNavigationRoute =
    navigationRoutes[selectedRouteIndex] || null;
  const navigationDuration = activeNavigationRoute
    ? Math.max(
        10000,
        Math.min(
          120000,
          (activeNavigationRoute.durationSeconds * 1000) / 60
        )
      )
    : NAVIGATION_PLAYBACK_MS;

  useEffect(() => {
    if (
      mode !== "navigation" ||
      navigationStatus !== "running" ||
      !activeNavigationRoute
    ) {
      return undefined;
    }

    const startProgress = navigationProgressRef.current;
    const startedAt =
      performance.now() -
      (startProgress * navigationDuration) / playbackSpeed;
    let frameId;

    const animate = (now) => {
      const nextProgress = Math.min(
        1,
        ((now - startedAt) * playbackSpeed) / navigationDuration
      );
      navigationProgressRef.current = nextProgress;
      setNavigationProgress(nextProgress);
      if (nextProgress < 1) {
        frameId = window.requestAnimationFrame(animate);
      } else {
        setNavigationStatus("completed");
      }
    };

    frameId = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frameId);
  }, [
    activeNavigationRoute,
    mode,
    navigationDuration,
    navigationStatus,
    playbackSpeed,
  ]);

  const choosePlace = useCallback((which, place) => {
    if (which === "start") setStartPlace(place);
    else setDestinationPlace(place);
    setNavigationRoutes([]);
    setSelectedRouteIndex(0);
    setNavigationStatus("idle");
    navigationProgressRef.current = 0;
    setNavigationProgress(0);
    setNavigationError("");
  }, []);

  function chooseRoute(index) {
    if (navigationStatus === "running") return;
    setSelectedRouteIndex(index);
    navigationProgressRef.current = 0;
    setNavigationProgress(0);
    setNavigationStatus("ready");
  }

  function resetNavigation() {
    navigationProgressRef.current = 0;
    setNavigationProgress(0);
    setNavigationStatus(activeNavigationRoute ? "ready" : "idle");
  }

  function startSimulation() {
    if (!routes || loading) return;

    collisionHandledRef.current = false;
    setIncident(null);
    setHospitals([]);
    setHospitalStatus("idle");
    setHospitalError("");
    setHospitalRoute(null);
    setHospitalRouteStatus("idle");
    setHospitalRouteError("");
    setIncidentSaveState({ status: "idle", message: "" });
    setClassification(null);
    setNotificationDelivery(null);
    setProgress(0);
    setStatus("running");
  }

  useEffect(() => {
    if (status !== "running" || !routes) return undefined;

    const startedAt = performance.now();
    let frameId;
    const animate = (now) => {
      const nextProgress = Math.min(
        1,
        (now - startedAt) / SIMULATION_DURATION_MS
      );
      setProgress(nextProgress);
      if (nextProgress < 1) {
        frameId = window.requestAnimationFrame(animate);
      }
    };
    frameId = window.requestAnimationFrame(animate);

    return () => window.cancelAnimationFrame(frameId);
  }, [status, routes]);

  useEffect(() => {
    if (
      status !== "running" ||
      progress < 1 ||
      !routes ||
      collisionHandledRef.current
    ) {
      return;
    }

    collisionHandledRef.current = true;
    const [lat, lon] = routes.collisionPoint;

    const newIncident = {
      eventId: `simulation-${crypto.randomUUID()}`,
      latitude: Number(lat.toFixed(6)),
      longitude: Number(lon.toFixed(6)),
      timestamp: new Date().toISOString(),
      mapsUrl: `https://www.google.com/maps?q=${lat},${lon}`,
      type: "SIMULATED COLLISION",
    };
    latestIncidentRef.current = newIncident;
    setIncident(newIncident);
    setStatus("collision");
  }, [progress, status, routes]);

  const saveIncident = useCallback(
    (currentIncident) => {
      const pendingRequest = savePromisesRef.current.get(
        currentIncident.eventId
      );
      if (pendingRequest) return pendingRequest;
      savePendingRef.current.add(currentIncident.eventId);
      const request = (async () => {
        if (latestIncidentRef.current?.eventId === currentIncident.eventId) {
          setIncidentSaveState({
            status: "saving",
            message: "Saving to C++ incident history...",
          });
        }

        try {
          let result = await postJson(`${backendUrl}/api/accident`, {
            eventId: currentIncident.eventId,
            timestamp: currentIncident.timestamp,
            speedA: currentIncident.speedA ?? simulationSpeedKmh,
            speedB: currentIncident.speedB ?? simulationSpeedKmh,
            massA: 1500,
            massB: 1500,
            collisionType: currentIncident.collisionType || "head-on",
            latitude: currentIncident.latitude,
            longitude: currentIncident.longitude,
            vehicleAId: currentIncident.vehicleAId || "SIM-CAR-A",
            vehicleBId: currentIncident.vehicleBId || "SIM-CAR-B",
            evidence: [
              {
                type: "multi_vehicle_road_simulation",
                label: `${currentIncident.vehicleAId || "SIM-CAR-A"} and ${currentIncident.vehicleBId || "SIM-CAR-B"} were detected together from changing OSRM route positions.`,
              },
              {
                type: "simulated_gps",
                label: "Coordinates are map-derived and are not vehicle GPS data.",
              },
              {
                type: "simulation_score_input",
                label: `C++ score input: ${currentIncident.speedA ?? simulationSpeedKmh} km/h and ${currentIncident.speedB ?? simulationSpeedKmh} km/h; demo value, not sensor telemetry.`,
              },
            ],
          });
          let idConfirmedFromHistory = false;

          if (!Number.isFinite(result.id)) {
            const history = await getJson(
              `${backendUrl}/api/accidents/history`
            );
            const accidents = Array.isArray(history.accidents)
              ? history.accidents
              : [];
            const sameEvent = accidents.filter(
              (record) =>
                record.eventId === currentIncident.eventId &&
                Number.isFinite(Number(record.id))
            );
            const matchingLocationAndClassification = accidents.filter(
              (record) =>
                Number.isFinite(Number(record.id)) &&
                record.severity === result.severity &&
                record.impactScore === result.impactScore &&
                record.hasLocation === true &&
                Math.abs(record.latitude - currentIncident.latitude) <=
                  0.00001 &&
                Math.abs(record.longitude - currentIncident.longitude) <=
                  0.00001
            );
            const eventTime = Date.parse(currentIncident.timestamp);
            const recentMatches = matchingLocationAndClassification.filter(
              (record) => {
                const recordTime = Date.parse(record.timestamp);
                return (
                  Number.isFinite(recordTime) &&
                  Number.isFinite(eventTime) &&
                  Math.abs(recordTime - eventTime) <= 180000
                );
              }
            );
            const matchedRecord =
              sameEvent.length === 1
                ? sameEvent[0]
                : recentMatches.length === 1
                  ? recentMatches[0]
                  : matchingLocationAndClassification.length === 1
                    ? matchingLocationAndClassification[0]
                    : null;
            if (!matchedRecord) {
              throw new Error(
                "The C++ backend omitted the accident ID, and its history did not contain one unique matching record."
              );
            }
            result = { ...result, id: Number(matchedRecord.id) };
            idConfirmedFromHistory = true;
          }

          if (
            !Number.isFinite(result.id) ||
            !Number.isFinite(result.impactScore) ||
            !["No Accident", "Minor", "Moderate", "Severe"].includes(
              result.severity
            )
          ) {
            throw new Error(
              "The C++ backend did not return its accident ID and decision-tree classification."
            );
          }

          const classificationResult = {
            accidentId: result.id,
            impactScore: result.impactScore,
            severity: result.severity,
            processingStatus: result.processingStatus || "Pending",
          };
          if (latestIncidentRef.current?.eventId === currentIncident.eventId) {
            setClassification(classificationResult);
            setIncidentSaveState({
              status: "saved",
              message: result.duplicate
                ? `Incident #${result.id} was already saved.`
                : `Recorded by the C++ backend as incident #${result.id}.${idConfirmedFromHistory ? " ID confirmed through history because the POST response omitted it." : ""}`,
            });
          }
          await onIncidentSaved?.();
          return classificationResult;
        } catch (saveError) {
          if (latestIncidentRef.current?.eventId === currentIncident.eventId) {
            setIncidentSaveState({
              status: "error",
              message:
                saveError.message ||
                "Could not save this simulation to incident history.",
            });
          }
          return null;
        } finally {
          savePendingRef.current.delete(currentIncident.eventId);
          savePromisesRef.current.delete(currentIncident.eventId);
        }
      })();
      savePromisesRef.current.set(currentIncident.eventId, request);
      return request;
    },
    [backendUrl, onIncidentSaved, simulationSpeedKmh]
  );

  useEffect(() => {
    if (incident) {
      latestIncidentRef.current = incident;
      void saveIncident(incident);
    }
  }, [incident, saveIncident]);

  const handleTrafficCollision = useCallback(
    async (trafficIncident) => {
      latestIncidentRef.current = trafficIncident;
      setIncident(trafficIncident);
      setClassification(null);
      setIncidentSaveState({ status: "saving", message: "Submitting collision to C++ backend..." });
      setNotificationDelivery(null);
      setHospitals([]);
      setHospitalStatus("idle");
      setHospitalError("");
      setHospitalRoute(null);
      setHospitalRouteStatus("idle");
      setHospitalRouteError("");
      return saveIncident(trafficIncident);
    },
    [saveIncident]
  );

  useEffect(() => {
    if (!incident) return undefined;

    const controller = new AbortController();
    hospitalControllersRef.current.set(incident.eventId, controller);
    const isLatestIncident = () =>
      latestIncidentRef.current?.eventId === incident.eventId;

    async function findHospitals() {
      if (isLatestIncident()) {
        setHospitalStatus("loading");
        setHospitalError("");
        setHospitalRoute(null);
        setHospitalRouteStatus("idle");
        setHospitalRouteError("");
      }

      const { latitude, longitude } = incident;

      const query = `
        [out:json][timeout:25];
        (
          node["amenity"="hospital"](around:6000,${latitude},${longitude});
          way["amenity"="hospital"](around:6000,${latitude},${longitude});
          relation["amenity"="hospital"](around:6000,${latitude},${longitude});
          node["healthcare"="hospital"](around:6000,${latitude},${longitude});
          way["healthcare"="hospital"](around:6000,${latitude},${longitude});
          relation["healthcare"="hospital"](around:6000,${latitude},${longitude});
        );
        out center tags;
      `;

      try {
        const endpoints = [
          "https://overpass-api.de/api/interpreter",
          "https://overpass.kumi.systems/api/interpreter",
        ];
        let data = null;
        let searchError = null;

        for (const endpoint of endpoints) {
          try {
            const url = `${endpoint}?data=${encodeURIComponent(query)}`;
            data = await fetchJsonWithTimeout(url, {
              signal: controller.signal,
              timeoutMs: 12000,
            });
            break;
          } catch (error) {
            if (controller.signal.aborted) throw error;
            searchError = error;
          }
        }

        if (!data) {
          throw new Error(
            searchError?.message || "All nearby hospital search services failed."
          );
        }

        const accidentPoint = [latitude, longitude];
        const found = parseNearbyHospitals(
          data.elements || [],
          accidentPoint
        );

        if (isLatestIncident()) {
          setHospitals(found);
          setHospitalStatus("complete");
        }
        if (!found.length) {
          if (isLatestIncident()) setHospitalRouteStatus("empty");
          return;
        }
        if (isLatestIncident()) {
          setHospitalRouteStatus("loading");
        }
        try {
          const nearest = found[0];
          const roadRoutes = await fetchNavigationRoutes(
            {
              name: "Simulated accident",
              lat: latitude,
              lon: longitude,
            },
            {
              name: nearest.name,
              lat: nearest.lat,
              lon: nearest.lon,
            },
            controller.signal
          );
          if (isLatestIncident()) {
            setHospitalRoute(roadRoutes[0]);
            setHospitalRouteStatus("ready");
          }
        } catch (routeError) {
          if (isLatestIncident()) {
            setHospitalRouteError(
              routeError.message || "Hospital road route is unavailable."
            );
            setHospitalRouteStatus("error");
          }
        }
      } catch (error) {
        if (isLatestIncident()) {
          setHospitalError(
            error.message || "Nearby hospital search failed at both services."
          );
          setHospitalStatus("error");
          setHospitalRouteStatus("error");
        }
      } finally {
        hospitalControllersRef.current.delete(incident.eventId);
      }
    }

    void findHospitals();
  }, [incident]);

  useEffect(
    () => () => {
      hospitalControllersRef.current.forEach((controller) =>
        controller.abort()
      );
      hospitalControllersRef.current.clear();
    },
    []
  );

  const notifyIncident = useCallback(
    async (currentIncident, currentClassification) => {
      const eventId = currentIncident.eventId;
      if (
        notificationPendingRef.current.has(eventId) ||
        notificationSentRef.current.has(eventId)
      ) {
        return;
      }

      notificationPendingRef.current.add(eventId);
      setNotificationDelivery({
        status: "pending",
        message:
          "Checking configured DEMO SMS mode; no emergency contacts or hospitals are notified.",
      });

      try {
        const result = await postJson(
          `${notificationUrl}/api/simulation-accident`,
          {
            incidentId: eventId,
            latitude: currentIncident.latitude,
            longitude: currentIncident.longitude,
            timestamp: currentIncident.timestamp,
            accidentId: currentClassification.accidentId,
            impactScore: currentClassification.impactScore,
            severity: currentClassification.severity,
            hospital: hospitals[0] || null,
          }
        );
        const acceptedCount = Number(result.sentCount) || 0;
        const totalContacts = Number(result.totalContacts) || 0;
        const deliveryStatus =
          result.status === "test_mode"
            ? "test_mode"
            : acceptedCount === totalContacts && totalContacts > 0
              ? "sent"
              : acceptedCount > 0
                ? "partial"
                : "error";
        if (deliveryStatus === "sent") {
          notificationSentRef.current.add(eventId);
        }
        setNotificationDelivery({
          status: deliveryStatus,
          message:
            result.message ||
            "The notification service accepted the DEMO alert request.",
        });
      } catch (notificationError) {
        setNotificationDelivery({
          status: "error",
          message:
            notificationError.message ||
            "The DEMO notification could not be sent.",
        });
      } finally {
        notificationPendingRef.current.delete(eventId);
      }
    },
    [hospitals, notificationUrl]
  );

  useEffect(() => {
    if (
      !incident ||
      !sendDemoAlerts ||
      incidentSaveState.status !== "saved" ||
      !classification ||
      hospitalStatus === "idle" ||
      hospitalStatus === "loading" ||
      hospitalRouteStatus === "idle" ||
      hospitalRouteStatus === "loading" ||
      notificationAttemptsRef.current.has(incident.eventId)
    ) {
      return;
    }

    if (classification.severity !== "Severe") {
      setNotificationDelivery({
        status: "not_required",
        message: `No demo SMS sent: the C++ decision tree classified this collision as ${classification.severity}; the demo alert is Severe-only.`,
      });
      return;
    }

    notificationAttemptsRef.current.add(incident.eventId);
    void notifyIncident(incident, classification);
  }, [
    classification,
    hospitalStatus,
    hospitalRouteStatus,
    incident,
    incidentSaveState.status,
    notifyIncident,
    sendDemoAlerts,
  ]);

  function retryNotification() {
    if (!incident || !classification || classification.severity !== "Severe") {
      return;
    }
    notificationAttemptsRef.current.delete(incident.eventId);
    void notifyIncident(incident, classification);
  }

  const car1Position = routes
    ? status === "collision"
      ? pointBeforeEnd(routes.vehicleA.coordinates)
      : pointAtFraction(routes.vehicleA.coordinates, progress)
    : KARACHI_CENTER;

  const car2Position = routes
    ? status === "collision"
      ? pointBeforeEnd(routes.vehicleB.coordinates)
      : pointAtFraction(routes.vehicleB.coordinates, progress)
    : KARACHI_CENTER;

  const car1Heading = routes
    ? bearingAtFraction(routes.vehicleA.coordinates, progress)
    : 0;

  const car2Heading = routes
    ? bearingAtFraction(routes.vehicleB.coordinates, progress)
    : 180;
  const navigationBounds = useMemo(
    () => navigationRoutes.flatMap((route) => route.coordinates),
    [navigationRoutes]
  );
  const simulationBounds = useMemo(
    () =>
      routes
        ? [
            ...routes.coordinates,
            ...(hospitalRoute?.coordinates || []),
          ]
        : [],
    [hospitalRoute, routes]
  );
  const navigationPosition = activeNavigationRoute
    ? pointAtFraction(
        activeNavigationRoute.coordinates,
        navigationProgress
      )
    : [startPlace.lat, startPlace.lon];
  const navigationHeading = activeNavigationRoute
    ? bearingAtFraction(
        activeNavigationRoute.coordinates,
        navigationProgress
      )
    : 0;

  return (
    <div style={{ display: "grid", gap: 18, color: "inherit" }}>
      <style>{`
        .simulation-marker {
          background: transparent;
          border: 0;
        }

        .accident-pulse {
          animation: accidentPulse 1s ease-in-out infinite alternate;
        }

        .collision-impact {
          width: 52px;
          height: 52px;
          border: 3px solid #fbbf24;
          border-radius: 50%;
          box-shadow: 0 0 18px #f97316cc;
          animation: collisionImpact 700ms ease-out 3 both;
        }

        @keyframes collisionImpact {
          from {
            opacity: 1;
            transform: scale(.2);
          }
          to {
            opacity: 0;
            transform: scale(1.3);
          }
        }

        @keyframes accidentPulse {
          from {
            transform: scale(.88);
            box-shadow: 0 0 0 4px #dc262633, 0 3px 14px #0008;
          }
          to {
            transform: scale(1.12);
            box-shadow: 0 0 0 13px #dc262622, 0 3px 18px #0008;
          }
        }
      `}</style>

      <div
        role="tablist"
        aria-label="Map experience"
        style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
      >
        {[
          ["traffic", "Multi-Vehicle Traffic"],
          ["simulation", "Accident Simulation"],
          ["navigation", "Road Navigation"],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            disabled={
              navigationStatus === "running" ||
              status === "running" ||
              trafficRunning
            }
            onClick={() => setMode(value)}
            style={{
              ...buttonStyle,
              color: mode === value ? "#fff" : "#c5d1df",
              background: mode === value ? "#1d4ed8" : "#172334",
              border: "1px solid #33475e",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "traffic" ? (
        <MultiVehicleTraffic
          startPlace={startPlace}
          destinationPlace={destinationPlace}
          onSelectPlace={choosePlace}
          simulationSpeedKmh={simulationSpeedKmh}
          setSimulationSpeedKmh={setSimulationSpeedKmh}
          sendDemoAlerts={sendDemoAlerts}
          setSendDemoAlerts={setSendDemoAlerts}
          onCollisionDetected={handleTrafficCollision}
          onRunningChange={setTrafficRunning}
          incident={incident}
          classification={classification}
          incidentSaveState={incidentSaveState}
          hospitalStatus={hospitalStatus}
          hospitalError={hospitalError}
          hospitals={hospitals}
          hospitalRouteStatus={hospitalRouteStatus}
          hospitalRoute={hospitalRoute}
          hospitalRouteError={hospitalRouteError}
          notificationDelivery={notificationDelivery}
          onRetryNotification={retryNotification}
        />
      ) : (
        <>
      <div
        role="note"
        style={{
          ...cardStyle,
          borderColor: "#f59e0b",
          color: "#fde68a",
        }}
      >
        DEMO ONLY — two vehicles approach on separate real-road routes and
        automatically collide at the mapped intersection. Coordinates are
        map-derived, not live GPS. Severity and impact score come from the C++
        backend; no real emergency contact is messaged.
      </div>

      {mode === "navigation" ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <div style={{ ...cardStyle, flex: 1, minWidth: 180 }}>
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              NAVIGATION
            </div>
            <strong style={{ fontSize: 19 }}>
              {navigationStatus === "running"
                ? "DEMO route in progress"
                : navigationStatus === "paused"
                  ? "Navigation paused"
                  : navigationStatus === "completed"
                    ? "Destination reached"
                    : activeNavigationRoute
                      ? "Route ready"
                      : navigationLoading
                        ? "Finding routes…"
                        : "Choose locations"}
            </strong>
          </div>
          <div style={{ ...cardStyle, flex: 1, minWidth: 180 }}>
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              SELECTED ROAD ROUTE
            </div>
            <strong style={{ fontSize: 19 }}>
              {activeNavigationRoute
                ? `${activeNavigationRoute.distanceKm.toFixed(1)} km`
                : "--"}
            </strong>
          </div>
          <div style={{ ...cardStyle, flex: 1, minWidth: 180 }}>
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              VEHICLE POSITION · DEMO
            </div>
            <strong style={{ fontSize: 14 }}>
              {navigationPosition[0].toFixed(5)},{" "}
              {navigationPosition[1].toFixed(5)}
            </strong>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <div style={{ ...cardStyle, flex: 1, minWidth: 180 }}>
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              SIMULATION STATUS
            </div>
            <strong style={{ fontSize: 19 }}>
              {status === "running"
                ? "Cars moving"
                : status === "collision"
                  ? "Collision detected"
                  : "Ready"}
            </strong>
          </div>
          <div style={{ ...cardStyle, flex: 1, minWidth: 180 }}>
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              ROAD DISTANCE
            </div>
            <strong style={{ fontSize: 19 }}>
              {routes ? `${routes.totalDistance.toFixed(2)} km total` : "--"}
            </strong>
          </div>
          <div style={{ ...cardStyle, flex: 1, minWidth: 180 }}>
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              NEARBY HOSPITALS
            </div>
            <strong style={{ fontSize: 19 }}>{hospitals.length}</strong>
          </div>
          <div style={{ ...cardStyle, flex: 1, minWidth: 180 }}>
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              C++ DECISION-TREE SEVERITY
            </div>
            <strong style={{ fontSize: 19 }}>
              {classification?.severity || "Awaiting collision"}
            </strong>
          </div>
          <div style={{ ...cardStyle, flex: 1, minWidth: 180 }}>
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              BACKEND IMPACT SCORE
            </div>
            <strong style={{ fontSize: 19 }}>
              {classification?.impactScore ?? "--"}
            </strong>
          </div>
        </div>
      )}

      {mode === "simulation" && (
        <div style={{ ...cardStyle, display: "grid", gap: 8 }}>
          <label
            htmlFor="simulation-speed"
            style={{ color: "#b9c9dc", fontWeight: 700 }}
          >
            C++ score input per vehicle
          </label>
          <select
            id="simulation-speed"
            value={simulationSpeedKmh}
            onChange={(event) =>
              setSimulationSpeedKmh(Number(event.target.value))
            }
            disabled={status === "running"}
            style={{
              width: "fit-content",
              padding: "8px 10px",
              color: "#e5edf7",
              background: "#0b1420",
              border: "1px solid #3b5068",
              borderRadius: 8,
            }}
          >
            {SIMULATION_SPEED_OPTIONS_KMH.map((speed) => (
              <option key={speed} value={speed}>
                {speed} km/h
              </option>
            ))}
          </select>
          <small style={{ color: "#9bacbf" }}>
            This demo input is sent to the existing C++ score formula; it is
            not measured GPS, speed, or impact-sensor data. The road animation
            is accelerated for demonstration.
          </small>
        </div>
      )}

      <div style={cardStyle}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            marginBottom: 14,
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 20 }}>
              {mode === "navigation"
                ? "Karachi Road Navigation"
                : `${COLLISION_INTERSECTION.name} Two-Vehicle Collision`}
            </h2>

            <p style={{ color: "#94a3b8", margin: "5px 0 0" }}>
              {mode === "navigation"
                ? "Search real places and preview road routes."
                : "Sedan and SUV approach on intersecting roads, collide, and trigger C++ accident classification."}
            </p>
          </div>

          {mode === "simulation" && (
            <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
              <button
                type="button"
                style={{
                  ...buttonStyle,
                  background: "#2563eb",
                  color: "white",
                  opacity:
                    !routes || loading || status === "running" ? 0.55 : 1,
                }}
                disabled={!routes || loading || status === "running"}
                onClick={startSimulation}
              >
                Start Two-Vehicle Collision
              </button>
              <button
                type="button"
                style={{
                  ...buttonStyle,
                  background: "#334155",
                  color: "white",
                  opacity: loading || status === "running" ? 0.55 : 1,
                }}
                disabled={loading || status === "running"}
                onClick={loadRandomRoute}
              >
                {loading ? "Loading..." : "New Random Route"}
              </button>
            </div>
          )}
        </div>

        {mode === "navigation" ? (
          <div
            style={{
              display: "grid",
              gap: 14,
              marginBottom: 14,
            }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              <LocationSearch
                label="Starting location"
                place={startPlace}
                onSelect={(place) => choosePlace("start", place)}
                disabled={navigationStatus === "running"}
              />
              <LocationSearch
                label="Destination"
                place={destinationPlace}
                onSelect={(place) => choosePlace("destination", place)}
                disabled={navigationStatus === "running"}
              />
              <button
                type="button"
                style={{
                  ...buttonStyle,
                  alignSelf: "end",
                  color: "#fff",
                  background: "#1d4ed8",
                }}
                disabled={
                  navigationLoading || navigationStatus === "running"
                }
                onClick={() => void loadNavigationRoutes()}
              >
                {navigationLoading ? "Finding routes…" : "Find Routes"}
              </button>
            </div>

            {navigationError && (
              <p role="alert" style={{ margin: 0, color: "#fca5a5" }}>
                {navigationError}
              </p>
            )}

            {navigationRoutes.length > 0 && (
              <>
                <div
                  role="group"
                  aria-label="Available road routes"
                  style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
                >
                  {navigationRoutes.map((route, index) => (
                    <button
                      key={route.id}
                      type="button"
                      aria-pressed={selectedRouteIndex === index}
                      disabled={navigationStatus === "running"}
                      onClick={() => chooseRoute(index)}
                      style={{
                        ...buttonStyle,
                        color: "#e5edf7",
                        background:
                          selectedRouteIndex === index ? "#173b78" : "#172334",
                        border: `1px solid ${
                          selectedRouteIndex === index ? "#3b82f6" : "#33475e"
                        }`,
                      }}
                    >
                      {index === 0 ? "Recommended" : `Alternative ${index}`} ·{" "}
                      {route.distanceKm.toFixed(1)} km ·{" "}
                      {Math.max(1, Math.round(route.durationSeconds / 60))} min
                    </button>
                  ))}
                </div>

                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 9,
                  }}
                >
                  <button
                    type="button"
                    style={{ ...buttonStyle, color: "#fff", background: "#15803d" }}
                    disabled={
                      navigationStatus === "running" ||
                      navigationStatus === "completed"
                    }
                    onClick={() => setNavigationStatus("running")}
                  >
                    {navigationStatus === "paused"
                      ? "Resume Navigation"
                      : "Start Navigation"}
                  </button>
                  <button
                    type="button"
                    style={{ ...buttonStyle, color: "#fff", background: "#475569" }}
                    disabled={navigationStatus !== "running"}
                    onClick={() => setNavigationStatus("paused")}
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    style={{ ...buttonStyle, color: "#e5edf7", background: "#253246" }}
                    disabled={navigationStatus === "idle"}
                    onClick={resetNavigation}
                  >
                    Reset
                  </button>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      color: "#c5d1df",
                      fontSize: 13,
                    }}
                  >
                    Playback speed
                    <select
                      value={playbackSpeed}
                      onChange={(event) =>
                        setPlaybackSpeed(Number(event.target.value))
                      }
                      style={{
                        padding: "8px 10px",
                        color: "#e5edf7",
                        background: "#0b1420",
                        border: "1px solid #3b5068",
                        borderRadius: 7,
                      }}
                    >
                      <option value={0.5}>0.5×</option>
                      <option value={1}>1×</option>
                      <option value={2}>2×</option>
                    </select>
                  </label>
                  <span style={{ color: "#9bacbf", fontSize: 12 }}>
                    {Math.round(navigationProgress * 100)}% complete
                  </span>
                </div>

                <div
                  aria-label="Route progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(navigationProgress * 100)}
                  style={{
                    height: 5,
                    overflow: "hidden",
                    background: "#263449",
                    borderRadius: 5,
                  }}
                >
                  <div
                    style={{
                      width: `${navigationProgress * 100}%`,
                      height: "100%",
                      background: "#3b82f6",
                      transition: "width 80ms linear",
                    }}
                  />
                </div>
                <small style={{ color: "#9bacbf" }}>
                  Route geometry and travel-time estimates come from OSRM; playback
                  is accelerated for demonstration. It is not live GPS or live
                  traffic.
                </small>
              </>
            )}
          </div>
        ) : (
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 9,
              marginBottom: 14,
              color: "#fde68a",
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={sendDemoAlerts}
              onChange={(event) => setSendDemoAlerts(event.target.checked)}
              disabled={status === "running"}
            />
            After C++ classifies the collision as Severe, send a DEMO SMS to
            the two configured demo contacts. This is not an emergency
            contact or hospital notification.
          </label>
        )}

        <div
          style={{
            height: 510,
            width: "100%",
            borderRadius: 10,
            overflow: "hidden",
            background: "#e2e8f0",
          }}
        >
          <MapContainer
            center={
              mode === "navigation"
                ? [startPlace.lat, startPlace.lon]
                : KARACHI_CENTER
            }
            zoom={12}
            style={{ height: "100%", width: "100%" }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {mode === "navigation" && navigationRoutes.length > 0 && (
              <FitRoute coordinates={navigationBounds} />
            )}

            {mode === "navigation" && (
              <>
                {navigationRoutes.map((route, index) => (
                  <Polyline
                    key={route.id}
                    positions={route.coordinates}
                    eventHandlers={{
                      click: () => {
                        if (navigationStatus !== "running") {
                          chooseRoute(index);
                        }
                      },
                    }}
                    pathOptions={{
                      color: selectedRouteIndex === index ? "#2563eb" : "#159447",
                      weight: selectedRouteIndex === index ? 7 : 5,
                      opacity: selectedRouteIndex === index ? 0.95 : 0.78,
                    }}
                  />
                ))}
                <CircleMarker
                  center={[startPlace.lat, startPlace.lon]}
                  radius={7}
                  pathOptions={{
                    color: "#fff",
                    fillColor: "#16a34a",
                    fillOpacity: 1,
                    weight: 2,
                  }}
                >
                  <Popup>Start: {startPlace.name}</Popup>
                </CircleMarker>
                <CircleMarker
                  center={[destinationPlace.lat, destinationPlace.lon]}
                  radius={7}
                  pathOptions={{
                    color: "#fff",
                    fillColor: "#dc2626",
                    fillOpacity: 1,
                    weight: 2,
                  }}
                >
                  <Popup>Destination: {destinationPlace.name}</Popup>
                </CircleMarker>
                {activeNavigationRoute && (
                  <Marker
                    position={navigationPosition}
                    icon={carIcon(navigationHeading)}
                    zIndexOffset={1500}
                  />
                )}
              </>
            )}

            {mode === "simulation" && routes && (
              <>
                <FitRoute coordinates={simulationBounds} />

                <Polyline
                  positions={routes.vehicleA.coordinates}
                  pathOptions={{
                    color: "#2563eb",
                    weight: 6,
                    opacity: 0.8,
                  }}
                />
                <Polyline
                  positions={routes.vehicleB.coordinates}
                  pathOptions={{
                    color: "#ea580c",
                    weight: 6,
                    opacity: 0.8,
                  }}
                />

                <CircleMarker
                  center={routes.vehicleA.coordinates[0]}
                  radius={7}
                  pathOptions={{
                    color: "#16a34a",
                    fillColor: "#16a34a",
                    fillOpacity: 1,
                  }}
                />

                <CircleMarker
                  center={routes.vehicleB.coordinates[0]}
                  radius={7}
                  pathOptions={{
                    color: "#7c3aed",
                    fillColor: "#7c3aed",
                    fillOpacity: 1,
                  }}
                />

                <CircleMarker
                  center={routes.collisionPoint}
                  radius={8}
                  pathOptions={{
                    color: "#dc2626",
                    fillColor: "#f87171",
                    fillOpacity: 0.9,
                    weight: 3,
                  }}
                />
                {hospitalRoute && (
                  <Polyline
                    positions={hospitalRoute.coordinates}
                    pathOptions={{
                      color: "#fbbf24",
                      weight: 5,
                      opacity: 0.9,
                      dashArray: "8 8",
                    }}
                  />
                )}

                {(status === "running" || status === "collision") && (
                  <>
                    <Marker
                      position={car1Position}
                      icon={carIcon(car1Heading, "sedan")}
                      zIndexOffset={1000}
                    />

                    <Marker
                      position={car2Position}
                      icon={carIcon(car2Heading, "suv")}
                      zIndexOffset={1001}
                    />
                  </>
                )}
              </>
            )}

            {status === "collision" && routes && (
              <Marker
                position={routes.collisionPoint}
                icon={impactIcon}
                interactive={false}
                zIndexOffset={1900}
              />
            )}

            {incident && (
              <Marker
                position={[incident.latitude, incident.longitude]}
                icon={accidentIcon}
                zIndexOffset={2000}
              />
            )}

            {hospitals.map((hospital) => (
              <Marker
                key={hospital.id}
                position={[hospital.lat, hospital.lon]}
                icon={hospitalIcon}
              />
            ))}
          </MapContainer>
        </div>

        {mode === "navigation" ? (
          <div
            className="map-legend"
            style={{ display: "flex", flexWrap: "wrap", gap: 12 }}
          >
            <span>
              <i
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: 18,
                  height: 4,
                  borderRadius: 4,
                  background: "#2563eb",
                }}
              />
              Selected route
            </span>
            <span>
              <i
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: 18,
                  height: 4,
                  borderRadius: 4,
                  background: "#159447",
                }}
              />
              Alternative route
            </span>
            <span style={{ width: "100%", color: "#fbbf24" }}>
              Traffic overlay unavailable — no live traffic provider is configured.
            </span>
            {[
              ["#22c55e", "Smooth"],
              ["#eab308", "Moderate"],
              ["#ef4444", "Heavy"],
              ["#64748b", "Closed"],
            ].map(([color, label]) => (
              <span key={label}>
                <i
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: 18,
                    height: 4,
                    borderRadius: 4,
                    background: color,
                  }}
                />
                {label}
              </span>
            ))}
            <span style={{ width: "100%" }}>
              Traffic colors are legend-only until a real traffic feed is connected.
            </span>
          </div>
        ) : (
          <p style={{ color: "#94a3b8", fontSize: 12, marginBottom: 0 }}>
            Blue and orange lines = separate routes to the shared collision point
            · Green and purple dots = vehicle starts · Red marker = simulated
            collision · Yellow dashed line = route to nearest listed hospital
            · Red crosses = hospitals
          </p>
        )}
      </div>

      {error && (
        <div style={{ ...cardStyle, color: "#fca5a5" }}>
          {error}
        </div>
      )}

      {incident && (
        <div style={{ ...cardStyle, borderColor: "#dc2626" }}>
          <h2 style={{ color: "#f87171", marginTop: 0 }}>
            Two-Vehicle Collision Detected
          </h2>

          <p>
            <strong>Accident ID:</strong>{" "}
            {classification?.accidentId ?? "Awaiting C++ backend"}
          </p>

          <p>
            <strong>Simulation event ID:</strong> {incident.eventId}
          </p>

          <p>
            <strong>C++ decision-tree severity:</strong>{" "}
            {classification?.severity ||
              (incidentSaveState.status === "error"
                ? "Not classified — backend request failed"
                : "Classification pending")}
          </p>

          <p>
            <strong>C++ impact score:</strong>{" "}
            {classification?.impactScore ?? "Pending backend calculation"}
          </p>

          <p>
            <strong>DSA processing status:</strong>{" "}
            {classification?.processingStatus ||
              (incidentSaveState.status === "error"
                ? "Not queued"
                : "Awaiting backend response")}
          </p>

          <p>
            <strong>Latitude:</strong> {incident.latitude}
          </p>

          <p>
            <strong>Longitude:</strong> {incident.longitude}
          </p>

          <p>
            <strong>Detection time:</strong> {incident.timestamp}
          </p>

          <a
            href={incident.mapsUrl}
            target="_blank"
            rel="noreferrer"
            style={{ color: "#60a5fa" }}
          >
            Open accident location in Google Maps
          </a>

          <p role="status" style={{ marginBottom: 8 }}>
            <strong>C++ backend:</strong> {incidentSaveState.message || "Submitting collision event..."}
            {incidentSaveState.status === "error" && (
              <>
                {" "}
                <button
                  type="button"
                  style={{ ...buttonStyle, padding: "6px 10px" }}
                  onClick={() => void saveIncident(incident)}
                >
                  Retry save
                </button>
              </>
            )}
          </p>

          {notificationDelivery && (
            <p role="status" style={{ marginBottom: 8 }}>
              <strong>DEMO SMS status ({notificationDelivery.status}):</strong>{" "}
              {notificationDelivery.message}
              {notificationDelivery.status === "error" && (
                <>
                  {" "}
                  <button
                    type="button"
                    style={{ ...buttonStyle, padding: "6px 10px" }}
                    onClick={retryNotification}
                  >
                    Retry notification
                  </button>
                </>
              )}
            </p>
          )}

          <h3>Nearby Hospitals (within 6 km)</h3>

          {hospitalStatus === "loading" && (
            <p>Searching OpenStreetMap...</p>
          )}

          {hospitalStatus === "error" && (
            <p role="alert">
              Nearby hospital search failed: {hospitalError}
            </p>
          )}

          {hospitalStatus === "complete" && hospitals.length === 0 && (
            <p>
              No hospitals found in the OpenStreetMap search results.
            </p>
          )}
          {hospitalRouteStatus === "loading" && (
            <p>Finding a road route to the nearest listed hospital…</p>
          )}
          {hospitalRouteStatus === "ready" && hospitalRoute && (
            <p role="status">
              Road route to the nearest hospital:{" "}
              {hospitalRoute.distanceKm.toFixed(2)} km, about{" "}
              {Math.max(
                1,
                Math.round(hospitalRoute.durationSeconds / 60)
              )}{" "}
              min by OSRM estimate (live traffic not included).
            </p>
          )}
          {hospitalRouteStatus === "error" && (
            <p role="alert">
              {hospitalRouteError ||
                "A road route to the nearest hospital is unavailable."}
            </p>
          )}

          {hospitals.map((hospital, index) => (
            <div
              key={hospital.id}
              style={{
                padding: "12px 0",
                borderTop: "1px solid #334155",
              }}
            >
              <strong>
                {index + 1}. {hospital.name}
              </strong>

              <div style={{ color: "#94a3b8", fontSize: 13 }}>
                {hospital.distance.toFixed(2)} km away
              </div>
              {hospital.address && (
                <div style={{ color: "#94a3b8", fontSize: 13 }}>
                  {hospital.address}
                </div>
              )}
              {hospital.phone && (
                <div style={{ color: "#fbbf24", fontSize: 12 }}>
                  OSM-listed phone (not independently verified):{" "}
                  {hospital.phone}
                </div>
              )}

              <a
                href={`https://www.google.com/maps?q=${hospital.lat},${hospital.lon}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: "#60a5fa", fontSize: 13 }}
              >
                View hospital
              </a>
            </div>
          ))}

          <p style={{ color: "#fbbf24", fontSize: 13 }}>
            DEMO ONLY: These coordinates are from the map simulation, not
            vehicle GPS. No emergency service or hospital is contacted.
          </p>
        </div>
      )}
        </>
      )}
    </div>
  );
}
