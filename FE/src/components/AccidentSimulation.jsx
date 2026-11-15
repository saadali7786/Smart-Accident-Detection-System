
import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import {
  bearingAtFraction,
  buildRoutePair,
  distanceKm,
  pointAtFraction,
} from "./accidentSimulationUtils";

const KARACHI_CENTER = [24.8607, 67.0011];
const COLLISION_INTERSECTION = {
  name: "NIPA Chowk",
  coordinates: [24.9179812, 67.0969429],
};
const ARRIVAL_BEARINGS = [135, 315];
const SIMULATION_DURATION_MS = 8500;
const SIMULATION_SPEED_KMH = 40;
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

// Original top-view sedan and SUV designs.
const carIcon = (color, rotation = 0, type = "sedan") => {
  const body =
    type === "suv"
      ? `<path d="M15 17 Q15 7 24 6 H40 Q49 7 49 17 L55 31 V76 Q55 91 44 94 H20 Q9 91 9 76 V31 Z"
          fill="${color}" stroke="#f8fafc" stroke-width="2.4"/>`
      : `<path d="M17 15 Q18 6 27 5 H37 Q46 6 47 15 L54 30 V76 Q54 89 43 93 H21 Q10 89 10 76 V30 Z"
          fill="${color}" stroke="#f8fafc" stroke-width="2.4"/>`;

  const html = `
    <div style="
      width:46px;height:68px;display:flex;align-items:center;justify-content:center;
      transform:rotate(${rotation}deg);
      filter:drop-shadow(0 4px 4px rgba(0,0,0,.55));
    ">
      <svg viewBox="0 0 64 100" width="46" height="68">
        <rect x="4" y="20" width="10" height="23" rx="3" fill="#111827"/>
        <rect x="50" y="20" width="10" height="23" rx="3" fill="#111827"/>
        <rect x="4" y="62" width="10" height="23" rx="3" fill="#111827"/>
        <rect x="50" y="62" width="10" height="23" rx="3" fill="#111827"/>
        ${body}
        <path d="M20 17 Q21 12 27 12 H37 Q43 12 44 17 L47 31 H17 Z"
          fill="#bae6fd" stroke="#0f172a" stroke-width="2"/>
        <rect x="17" y="34" width="30" height="29" rx="7"
          fill="#172554" stroke="#e2e8f0" stroke-width="1.5"/>
        <path d="M17 67 H47 L43 81 Q32 85 21 81 Z"
          fill="#93c5fd" stroke="#0f172a" stroke-width="2"/>
        <path d="M20 38 H44 M20 58 H44"
          stroke="#64748b" stroke-width="1" opacity=".7"/>
        <rect x="14" y="7" width="10" height="5" rx="2" fill="#fef08a"/>
        <rect x="40" y="7" width="10" height="5" rx="2" fill="#fef08a"/>
        <rect x="14" y="88" width="10" height="5" rx="2" fill="#ef4444"/>
        <rect x="40" y="88" width="10" height="5" rx="2" fill="#ef4444"/>
        <path d="M26 8 H38" stroke="#fff" stroke-width="1.5" opacity=".8"/>
      </svg>
    </div>`;

  return L.divIcon({
    className: "simulation-marker vehicle-marker",
    html,
    iconSize: [46, 68],
    iconAnchor: [23, 34],
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
    width:40px;height:40px;border-radius:50%;background:#dc2626;
    border:3px solid white;color:white;display:flex;align-items:center;
    justify-content:center;font-size:25px;font-weight:900;
    box-shadow:0 0 0 7px #dc262655,0 3px 14px #0008;">!</div>`,
  iconSize: [40, 40],
  iconAnchor: [20, 20],
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

export default function AccidentSimulation({
  backendUrl = DEFAULT_BACKEND_URL,
  notificationUrl = DEFAULT_NOTIFICATION_URL,
  onIncidentSaved,
}) {
  const [routes, setRoutes] = useState(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("idle");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [incident, setIncident] = useState(null);
  const [hospitals, setHospitals] = useState([]);
  const [hospitalStatus, setHospitalStatus] = useState("idle");
  const [incidentSaveState, setIncidentSaveState] = useState({
    status: "idle",
    message: "",
  });
  const [notificationDelivery, setNotificationDelivery] = useState(null);
  const [sendDemoAlerts, setSendDemoAlerts] = useState(false);
  const collisionHandledRef = useRef(false);
  const savePendingRef = useRef(new Set());
  const notificationAttemptsRef = useRef(new Set());
  const notificationPendingRef = useRef(new Set());
  const notificationSentRef = useRef(new Set());

  const loadRandomRoute = useCallback(async () => {
    setLoading(true);
    setError("");
    setStatus("idle");
    setProgress(0);
    setRoutes(null);
    setIncident(null);
    setHospitals([]);
    setHospitalStatus("idle");
    setIncidentSaveState({ status: "idle", message: "" });
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
    void loadRandomRoute();
  }, [loadRandomRoute]);

  function startSimulation() {
    if (!routes || loading) return;

    collisionHandledRef.current = false;
    setIncident(null);
    setHospitals([]);
    setHospitalStatus("idle");
    setIncidentSaveState({ status: "idle", message: "" });
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

    setIncident({
      eventId: `simulation-${crypto.randomUUID()}`,
      latitude: Number(lat.toFixed(6)),
      longitude: Number(lon.toFixed(6)),
      timestamp: new Date().toISOString(),
      mapsUrl: `https://www.google.com/maps?q=${lat},${lon}`,
      type: "SIMULATED COLLISION",
    });
    setStatus("collision");
  }, [progress, status, routes]);

  const saveIncident = useCallback(
    async (currentIncident) => {
      if (savePendingRef.current.has(currentIncident.eventId)) return;
      savePendingRef.current.add(currentIncident.eventId);
      setIncidentSaveState({ status: "saving", message: "Saving to C++ incident history..." });

      try {
        const result = await postJson(`${backendUrl}/api/accident`, {
          eventId: currentIncident.eventId,
          timestamp: currentIncident.timestamp,
          speedA: SIMULATION_SPEED_KMH,
          speedB: SIMULATION_SPEED_KMH,
          massA: 1500,
          massB: 1500,
          collisionType: "head-on",
          impactG: 1.0,
          latitude: currentIncident.latitude,
          longitude: currentIncident.longitude,
          vehicleAId: "SIM-CAR-A",
          vehicleBId: "SIM-CAR-B",
          evidence: [
            {
              type: "simulation_two_routes",
              label: "Two independent road routes met at the simulated intersection.",
            },
            {
              type: "simulated_gps",
              label: "Coordinates are map-derived and are not vehicle GPS data.",
            },
          ],
        });

        setIncidentSaveState({
          status: "saved",
          message: result.duplicate
            ? `Incident #${result.id} was already saved.`
            : `Saved to C++ history as incident #${result.id}.`,
        });
        await onIncidentSaved?.();
      } catch (saveError) {
        setIncidentSaveState({
          status: "error",
          message: saveError.message || "Could not save this simulation to incident history.",
        });
      } finally {
        savePendingRef.current.delete(currentIncident.eventId);
      }
    },
    [backendUrl, onIncidentSaved]
  );

  useEffect(() => {
    if (incident) void saveIncident(incident);
  }, [incident, saveIncident]);

  useEffect(() => {
    if (!incident) return undefined;

    let cancelled = false;

    async function findHospitals() {
      setHospitalStatus("loading");

      const { latitude, longitude } = incident;

      const query = `
        [out:json][timeout:25];
        (
          node["amenity"="hospital"](around:6000,${latitude},${longitude});
          way["amenity"="hospital"](around:6000,${latitude},${longitude});
          relation["amenity"="hospital"](around:6000,${latitude},${longitude});
          node["healthcare"="hospital"](around:6000,${latitude},${longitude});
          way["healthcare"="hospital"](around:6000,${latitude},${longitude});
        );
        out center tags;
      `;

      try {
        const url =
          "https://overpass-api.de/api/interpreter?data=" +
          encodeURIComponent(query);

        const response = await fetch(url, {
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          throw new Error("Hospital search unavailable.");
        }

        const data = await response.json();
        const accidentPoint = [latitude, longitude];

        const found = (data.elements || [])
          .map((item) => {
            const lat = item.lat ?? item.center?.lat;
            const lon = item.lon ?? item.center?.lon;

            if (
              !Number.isFinite(lat) ||
              !Number.isFinite(lon) ||
              lat < -90 ||
              lat > 90 ||
              lon < -180 ||
              lon > 180
            ) {
              return null;
            }

            return {
              id: item.id,
              name: item.tags?.name || "Unnamed hospital",
              lat,
              lon,
              distance: distanceKm(accidentPoint, [lat, lon]),
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 5);

        if (!cancelled) {
          setHospitals(found);
          setHospitalStatus("complete");
        }
      } catch {
        if (!cancelled) {
          setHospitalStatus("error");
        }
      }
    }

    void findHospitals();

    return () => {
      cancelled = true;
    };
  }, [incident]);

  const notifyIncident = useCallback(
    async (currentIncident) => {
      const eventId = currentIncident.eventId;
      if (
        notificationPendingRef.current.has(eventId) ||
        notificationSentRef.current.has(eventId)
      ) {
        return;
      }

      notificationPendingRef.current.add(eventId);
      setNotificationDelivery({
        status: "sending",
        message: "Sending DEMO alert to configured demo contacts...",
      });

      try {
        const result = await postJson(
          `${notificationUrl}/api/simulation-accident`,
          {
            incidentId: eventId,
            latitude: currentIncident.latitude,
            longitude: currentIncident.longitude,
            timestamp: currentIncident.timestamp,
            hospital: hospitals[0] || null,
          }
        );
        notificationSentRef.current.add(eventId);
        setNotificationDelivery({
          status: "sent",
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
      hospitalStatus === "idle" ||
      hospitalStatus === "loading" ||
      notificationAttemptsRef.current.has(incident.eventId)
    ) {
      return;
    }

    notificationAttemptsRef.current.add(incident.eventId);
    void notifyIncident(incident);
  }, [
    hospitalStatus,
    incident,
    incidentSaveState.status,
    notifyIncident,
    sendDemoAlerts,
  ]);

  function retryNotification() {
    if (!incident) return;
    notificationAttemptsRef.current.delete(incident.eventId);
    void notifyIncident(incident);
  }

  const car1Position = routes
    ? pointAtFraction(routes.vehicleA.coordinates, progress)
    : KARACHI_CENTER;

  const car2Position = routes
    ? pointAtFraction(routes.vehicleB.coordinates, progress)
    : KARACHI_CENTER;

  const car1Heading = routes
    ? bearingAtFraction(routes.vehicleA.coordinates, progress)
    : 0;

  const car2Heading = routes
    ? bearingAtFraction(routes.vehicleB.coordinates, progress)
    : 180;

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
        role="note"
        style={{
          ...cardStyle,
          borderColor: "#f59e0b",
          color: "#fde68a",
        }}
      >
        DEMO ONLY — map-derived coordinates are not live vehicle GPS. No
        emergency services or hospitals are contacted.
      </div>

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
      </div>

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
              {COLLISION_INTERSECTION.name} Accident Simulation
            </h2>

            <p style={{ color: "#94a3b8", margin: "5px 0 0" }}>
              Two independent road approaches · Sedan vs SUV · Automatic
              collision
            </p>
          </div>

          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <button
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
              Start Simulation
            </button>

            <button
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
        </div>

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
          After the incident is saved, send a DEMO SMS to the two configured
          demo contacts.
        </label>

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
            center={KARACHI_CENTER}
            zoom={12}
            style={{ height: "100%", width: "100%" }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {routes && (
              <>
                <FitRoute coordinates={routes.coordinates} />

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

                {(status === "running" || status === "collision") && (
                  <>
                    <Marker
                      position={car1Position}
                      icon={carIcon("#2563eb", car1Heading, "sedan")}
                      zIndexOffset={1000}
                    />

                    <Marker
                      position={car2Position}
                      icon={carIcon("#ea580c", car2Heading, "suv")}
                      zIndexOffset={1001}
                    />
                  </>
                )}
              </>
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

        <p style={{ color: "#94a3b8", fontSize: 12, marginBottom: 0 }}>
          Blue and orange lines = separate routes to the shared collision point
          · Green and purple dots = vehicle starts · Red marker = simulated
          collision · Red crosses = hospitals
        </p>
      </div>

      {error && (
        <div style={{ ...cardStyle, color: "#fca5a5" }}>
          {error}
        </div>
      )}

      {incident && (
        <div style={{ ...cardStyle, borderColor: "#dc2626" }}>
          <h2 style={{ color: "#f87171", marginTop: 0 }}>
            Simulated Collision Location Captured
          </h2>

          <p>
            <strong>Incident ID:</strong> {incident.eventId}
          </p>

          <p>
            <strong>Latitude:</strong> {incident.latitude}
          </p>

          <p>
            <strong>Longitude:</strong> {incident.longitude}
          </p>

          <p>
            <strong>Timestamp:</strong> {incident.timestamp}
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
            <strong>C++ history:</strong> {incidentSaveState.message || "Saving..."}
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
              <strong>DEMO notification:</strong> {notificationDelivery.message}
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
            <p>Hospital search failed. Try again later.</p>
          )}

          {hospitalStatus === "complete" && hospitals.length === 0 && (
            <p>
              No hospitals found in the OpenStreetMap search results.
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
    </div>
  );
}
