
import { useCallback, useEffect, useState } from "react";
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

const KARACHI_CENTER = [24.8607, 67.0011];

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

function distanceKm(a, b) {
  const rad = (value) => (value * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const lat1 = rad(a[0]);
  const lat2 = rad(b[0]);

  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function pointAtFraction(points, fraction) {
  if (!points?.length) return KARACHI_CENTER;
  if (points.length === 1) return points[0];

  const lengths = [];
  let total = 0;

  for (let i = 1; i < points.length; i += 1) {
    const length = distanceKm(points[i - 1], points[i]);
    lengths.push(length);
    total += length;
  }

  let target = total * Math.max(0, Math.min(1, fraction));

  for (let i = 0; i < lengths.length; i += 1) {
    if (target <= lengths[i]) {
      const ratio = lengths[i] === 0 ? 0 : target / lengths[i];

      return [
        points[i][0] + (points[i + 1][0] - points[i][0]) * ratio,
        points[i][1] + (points[i + 1][1] - points[i][1]) * ratio,
      ];
    }

    target -= lengths[i];
  }

  return points[points.length - 1];
}

function bearingAtFraction(points, fraction) {
  const before = pointAtFraction(points, Math.max(0, fraction - 0.002));
  const after = pointAtFraction(points, Math.min(1, fraction + 0.002));

  const toRad = (value) => (value * Math.PI) / 180;
  const toDeg = (value) => (value * 180) / Math.PI;

  const lat1 = toRad(before[0]);
  const lat2 = toRad(after[0]);
  const dLon = toRad(after[1] - before[1]);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function FitRoute({ coordinates }) {
  const map = useMap();

  useEffect(() => {
    if (coordinates?.length > 1) {
      map.fitBounds(coordinates, { padding: [45, 45] });
    }
  }, [coordinates, map]);

  return null;
}

export default function AccidentSimulation() {
  const [route, setRoute] = useState(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("idle");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [incident, setIncident] = useState(null);
  const [hospitals, setHospitals] = useState([]);
  const [hospitalStatus, setHospitalStatus] = useState("idle");

  const loadRandomRoute = useCallback(async () => {
    setLoading(true);
    setError("");
    setStatus("idle");
    setProgress(0);
    setIncident(null);
    setHospitals([]);
    setHospitalStatus("idle");

    try {
      const firstIndex = Math.floor(Math.random() * LOCATIONS.length);
      let secondIndex = Math.floor(Math.random() * LOCATIONS.length);

      while (secondIndex === firstIndex) {
        secondIndex = Math.floor(Math.random() * LOCATIONS.length);
      }

      const start = LOCATIONS[firstIndex];
      const end = LOCATIONS[secondIndex];

      const url =
        `https://router.project-osrm.org/route/v1/driving/` +
        `${start.lon},${start.lat};${end.lon},${end.lat}` +
        `?overview=full&geometries=geojson&steps=false`;

      const response = await fetch(url, {
        signal: AbortSignal.timeout(20000),
      });

      if (!response.ok) {
        throw new Error("Road routing service unavailable.");
      }

      const result = await response.json();

      if (result.code !== "Ok" || !result.routes?.length) {
        throw new Error("Could not find a road route. Please try again.");
      }

      const coordinates = result.routes[0].geometry.coordinates.map(
        ([lon, lat]) => [lat, lon]
      );

      const collisionFraction = 0.35 + Math.random() * 0.3;

      setRoute({
        coordinates,
        start,
        end,
        collisionFraction,
        distance: result.routes[0].distance / 1000,
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
    if (!route || loading) return;

    setIncident(null);
    setHospitals([]);
    setHospitalStatus("idle");
    setProgress(0);
    setStatus("running");
  }

  // Progress timer. Collision is handled separately below.
  useEffect(() => {
    if (status !== "running" || !route) return undefined;

    const timer = window.setInterval(() => {
      setProgress((current) => Math.min(1, current + 0.002));
    }, 50);

    return () => window.clearInterval(timer);
  }, [status, route]);

  useEffect(() => {
    if (status !== "running" || progress < 1 || !route) return;

    const [lat, lon] = pointAtFraction(
      route.coordinates,
      route.collisionFraction
    );

    setIncident({
      latitude: Number(lat.toFixed(6)),
      longitude: Number(lon.toFixed(6)),
      timestamp: new Date().toISOString(),
      mapsUrl: `https://www.google.com/maps?q=${lat},${lon}`,
      type: "SIMULATED COLLISION",
    });

    setStatus("collision");
  }, [progress, status, route]);

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

            if (lat == null || lon == null) return null;

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

  const car1Fraction = route ? progress * route.collisionFraction : 0;

  const car2Fraction = route
    ? 1 - progress * (1 - route.collisionFraction)
    : 1;

  const car1Position = route
    ? pointAtFraction(route.coordinates, car1Fraction)
    : KARACHI_CENTER;

  const car2Position = route
    ? pointAtFraction(route.coordinates, car2Fraction)
    : KARACHI_CENTER;

  const car1Heading = route
    ? bearingAtFraction(route.coordinates, car1Fraction)
    : 0;

  const car2Heading = route
    ? (bearingAtFraction(route.coordinates, car2Fraction) + 180) % 360
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
            {route ? `${route.distance.toFixed(2)} km` : "--"}
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
              Karachi Accident Simulation
            </h2>

            <p style={{ color: "#94a3b8", margin: "5px 0 0" }}>
              Real roads · Sedan vs SUV · Automatic collision
            </p>
          </div>

          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <button
              style={{
                ...buttonStyle,
                background: "#2563eb",
                color: "white",
                opacity:
                  !route || loading || status === "running" ? 0.55 : 1,
              }}
              disabled={!route || loading || status === "running"}
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

            {route && (
              <>
                <FitRoute coordinates={route.coordinates} />

                <Polyline
                  positions={route.coordinates}
                  pathOptions={{
                    color: "#2563eb",
                    weight: 6,
                    opacity: 0.8,
                  }}
                />

                <CircleMarker
                  center={route.coordinates[0]}
                  radius={7}
                  pathOptions={{ color: "#16a34a", fillOpacity: 1 }}
                />

                <CircleMarker
                  center={route.coordinates[route.coordinates.length - 1]}
                  radius={7}
                  pathOptions={{ color: "#ea580c", fillOpacity: 1 }}
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
          Blue line = selected road · Blue sedan and orange SUV = opposing
          vehicles · Red marker = simulated collision · Red crosses = hospitals
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
            Accident Location Captured
          </h2>

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
            DEMO ONLY: This is a simulated collision. No SMS has been sent
            and no real emergency service has been contacted.
          </p>
        </div>
      )}
    </div>
  );
}
