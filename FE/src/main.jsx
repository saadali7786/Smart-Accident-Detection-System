import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  CarFront,
  Clock,
  MapPin,
  ShieldCheck,
  Siren,
  Zap,
  RotateCcw,
  Radio,
} from "lucide-react";
import "./style.css";

import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import AccidentGame, {
  getInitialVehiclePositions,
  getSimulatedCoordinates,
} from "./components/AccidentGame";

function BrowserGPSMarker({ onLocationFound, onLocationError }) {
  const [position, setPosition] = useState(null);

  useEffect(() => {
    if (!navigator.geolocation) {
      onLocationError("Geolocation is not supported by this browser.");
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (location) => {
        const newPosition = [
          location.coords.latitude,
          location.coords.longitude,
        ];
        setPosition(newPosition);
        onLocationFound(newPosition);
        onLocationError("");
      },
      (error) => {
        console.error("GPS Error:", error);
        onLocationError(
          error.message || "Unable to access your browser location."
        );
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 10000,
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [onLocationFound, onLocationError]);

  if (!position) return null;

  return (
    <Marker position={position}>
      <Popup>
        <strong>Current GPS Location</strong>
        <br />
        Latitude: {position[0].toFixed(6)}
        <br />
        Longitude: {position[1].toFixed(6)}
      </Popup>
    </Marker>
  );
}

function hasVehicleLocation(vehicle) {
  const latitude = Number(vehicle.latitude);
  const longitude = Number(vehicle.longitude);

  return (
    vehicle.lastUpdated &&
    vehicle.lastUpdated !== "Not updated" &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
  );
}

const vehicleIcons = {
  online: L.divIcon({
    className: "vehicle-marker-wrapper",
    html: '<span class="vehicle-map-marker vehicle-map-marker-online"></span>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  }),
  offline: L.divIcon({
    className: "vehicle-marker-wrapper",
    html: '<span class="vehicle-map-marker vehicle-map-marker-offline"></span>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  }),
};

const simulatedVehicleIcons = {
  vehicleA: L.divIcon({
    className: "simulated-marker-wrapper",
    html: '<span class="simulated-map-marker simulated-map-marker-a"></span>',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -13],
  }),
  vehicleB: L.divIcon({
    className: "simulated-marker-wrapper",
    html: '<span class="simulated-map-marker simulated-map-marker-b"></span>',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -13],
  }),
};

function getMapPositions(scenePositions) {
  return {
    vehicleA: getSimulatedCoordinates(scenePositions.vehicleA),
    vehicleB: getSimulatedCoordinates(scenePositions.vehicleB),
  };
}

function AnimatedVehicleMarker({ vehicle }) {
  const markerRef = useRef(null);
  const initialPosition = useRef([
    Number(vehicle.latitude),
    Number(vehicle.longitude),
  ]);
  const latitude = Number(vehicle.latitude);
  const longitude = Number(vehicle.longitude);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return undefined;

    const start = marker.getLatLng();
    const startTime = performance.now();
    const duration = 700;
    let animationFrame;

    function animate(timestamp) {
      const progress = Math.min((timestamp - startTime) / duration, 1);
      marker.setLatLng([
        start.lat + (latitude - start.lat) * progress,
        start.lng + (longitude - start.lng) * progress,
      ]);

      if (progress < 1) {
        animationFrame = requestAnimationFrame(animate);
      }
    }

    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [latitude, longitude]);

  return (
    <Marker
      ref={markerRef}
      position={initialPosition.current}
      icon={vehicle.isOnline ? vehicleIcons.online : vehicleIcons.offline}
    >
      <Popup>
        <strong>{vehicle.vehicleId}</strong>
        <br />
        Speed: {Number(vehicle.speed).toFixed(1)} km/h
        <br />
        Latitude: {latitude.toFixed(6)}
        <br />
        Longitude: {longitude.toFixed(6)}
        <br />
        Status: {vehicle.isOnline ? "Online" : "Offline"}
        <br />
        Updated: {vehicle.lastUpdated}
      </Popup>
    </Marker>
  );
}

function SimulatedVehicleMarker({ name, position, speed, icon }) {
  const markerRef = useRef(null);
  const initialPosition = useRef(position);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return undefined;

    const start = marker.getLatLng();
    const startedAt = performance.now();
    const duration = 180;
    let animationFrame;

    function animate(timestamp) {
      const progress = Math.min((timestamp - startedAt) / duration, 1);
      marker.setLatLng([
        start.lat + (position[0] - start.lat) * progress,
        start.lng + (position[1] - start.lng) * progress,
      ]);

      if (progress < 1) animationFrame = requestAnimationFrame(animate);
    }

    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [position]);

  return (
    <Marker ref={markerRef} position={initialPosition.current} icon={icon}>
      <Popup>
        <strong>{name}</strong>
        <br />
        Speed: {speed} km/h
        <br />
        Simulated GPS · demonstration only
        <br />
        Latitude: {position[0].toFixed(6)}
        <br />
        Longitude: {position[1].toFixed(6)}
      </Popup>
    </Marker>
  );
}

function FocusMapOnVehicle({ vehicle, request }) {
  const map = useMap();

  useEffect(() => {
    if (!vehicle || !hasVehicleLocation(vehicle)) return;
    map.flyTo(
      [Number(vehicle.latitude), Number(vehicle.longitude)],
      Math.max(map.getZoom(), 14),
      { duration: 0.8 }
    );
  }, [map, request]);

  return null;
}

function App() {
  const [speedA, setSpeedA] = useState(0);
  const [speedB, setSpeedB] = useState(0);
  const massA = 1500;
  const massB = 1500;
  const [simulationRunId, setSimulationRunId] = useState(0);
  const [simulationResetKey, setSimulationResetKey] = useState(0);
  const [simulationRunning, setSimulationRunning] = useState(false);
  const [simulatedPositions, setSimulatedPositions] = useState(() =>
    getMapPositions(getInitialVehiclePositions("head-on"))
  );
  const collisionSubmitted = useRef(false);
  const collisionRequestInProgress = useRef(false);

  const [gpsLocation, setGpsLocation] = useState(null);
  const [gpsError, setGpsError] = useState("");
  // Registered vehicle GPS tracking
  const [vehicles, setVehicles] = useState([]);
  const [vehicleError, setVehicleError] = useState("");
  const [vehicleLoading, setVehicleLoading] = useState(false);
  const [selectedVehicleId, setSelectedVehicleId] = useState("");
  const [mapFocusRequest, setMapFocusRequest] = useState(0);
  const vehicleFetchInProgress = useRef(false);
  const [impact, setImpact] = useState(null);
  const [severity, setSeverity] = useState("Waiting");
  const [collision, setCollision] = useState(false);
  const [events, setEvents] = useState([]);
  const [accidentHistory, setAccidentHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [alertStatus, setAlertStatus] = useState("Standby");
  const [historyError, setHistoryError] = useState("");
  const [dsaStatus, setDsaStatus] = useState({
    queueSize: 0,
    severeStackSize: 0,
    processedEvents: 0,
    totalEnqueuedEvents: 0,
    latestSevereEvent: null,
    queueEvents: [],
    stackEvents: [],
  });

  const [dsaLoading, setDsaLoading] = useState(false);
  const [dsaError, setDsaError] = useState("");
  const selectedVehicle = vehicles.find(
    (vehicle) => vehicle.vehicleId === selectedVehicleId
  );

  async function fetchAccidentHistory() {
    setHistoryLoading(true);
    setHistoryError("");

    try {
      const response = await fetch(
        "http://localhost:8080/api/accidents/history"
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error("Failed to fetch accident history");
      }

      setAccidentHistory(
        Array.isArray(result.accidents) ? result.accidents : []
      );

    } catch (error) {
      console.error("History fetch error:", error);
      setHistoryError("Could not load accident history.");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function fetchDsaStatus() {

    setDsaLoading(true);
    setDsaError("");

    try {
      const response = await fetch(
        "http://localhost:8080/api/dsa/status"
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error("Failed to fetch DSA status");
      }

      setDsaStatus({
        queueSize: result.queueSize,
        severeStackSize: result.severeStackSize,
        processedEvents: result.processedEvents,
        totalEnqueuedEvents: result.totalEnqueuedEvents,
        latestSevereEvent: result.latestSevereEvent,
        queueEvents: result.queueEvents || [],
        stackEvents: result.stackEvents || [],
      });

    } catch (error) {
      console.error("DSA status error:", error);
      setDsaError("Could not load DSA status.");
    } finally {
      setDsaLoading(false);
    }
  }

  async function processNextAccident() {
    if (dsaStatus.queueSize === 0) {
      alert("No pending accidents in the queue.");
      return;
    }

    try {
      const response = await fetch(
        "http://localhost:8080/api/dsa/process",
        {
          method: "POST",
        }
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(
          result.message || "Failed to process accident"
        );
      }

      alert(result.message);

      await fetchDsaStatus();
      await fetchAccidentHistory();

    } catch (error) {
      console.error("DSA processing error:", error);
      alert("Could not process the next accident.");
    }
  }

  // Fetch registered vehicles from C++ backend
  async function fetchRegisteredVehicles() {
    if (vehicleFetchInProgress.current) return;
    vehicleFetchInProgress.current = true;
    setVehicleLoading(true);
    setVehicleError("");

    try {
      const response = await fetch(
        "http://localhost:8080/api/vehicles"
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error("Failed to fetch registered vehicles");
      }

      setVehicles(
        Array.isArray(result.vehicles) ? result.vehicles : []
      );

    } catch (error) {
      console.error("Vehicle GPS fetch error:", error);
      setVehicleError("Could not load registered vehicles.");
    } finally {
      vehicleFetchInProgress.current = false;
      setVehicleLoading(false);
    }
  }

  useEffect(() => {
    fetchAccidentHistory();
    fetchDsaStatus();
    fetchRegisteredVehicles();

    // Refresh vehicle locations every 2 seconds
    const vehicleInterval = setInterval(() => {
      fetchRegisteredVehicles();
    }, 2000);

    return () => {
      clearInterval(vehicleInterval);
    };
  }, []);

  async function simulateCollision(event) {
    if (collisionSubmitted.current || collisionRequestInProgress.current) return;
    collisionSubmitted.current = true;
    collisionRequestInProgress.current = true;
    setCollision(true);
    setSimulationRunning(false);
    setSpeedA(event.speedA);
    setSpeedB(event.speedB);
    setAlertStatus("Processing");
    const midpoint = event.simulationCoordinates;
    const [latitude, longitude] = getSimulatedCoordinates(midpoint);

    try {
      const response = await fetch(
        "http://localhost:8080/api/accident",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            speedA: Number(event.speedA),
            speedB: Number(event.speedB),
            massA: Number(massA),
            massB: Number(massB),
            collisionType: event.collisionType,
            latitude,
            longitude,
            vehicleAId: event.vehicleAId,
            vehicleBId: event.vehicleBId,
            timestamp: event.timestamp,
            impactInfo: event.impactInfo,
            simulationCoordinates: event.simulationCoordinates,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.error || "Accident simulation failed"
        );
      }

      // Use the result calculated by the C++ backend.
      const score = result.impactScore;
      const level = result.severity;

      setImpact(score);
      setSeverity(level);
      setAlertStatus(result.alertStatus);

      // Refresh accident history from the C++ backend.
      await fetchAccidentHistory();
      await fetchDsaStatus();

    } catch (error) {
      console.error("Backend connection error:", error);
      setAlertStatus("Backend connection failed");
      alert(
        "Could not connect to the C++ backend. " +
        "Make sure accident_backend.exe is running on port 8080."
      );
    } finally {
      collisionRequestInProgress.current = false;
    }
  }

  function startSimulation() {
    if (
      simulationRunning ||
      collision ||
      collisionSubmitted.current ||
      collisionRequestInProgress.current
    ) {
      return;
    }

    setImpact(null);
    setSeverity("Waiting");
    setAlertStatus("Standby");
    setCollision(false);
    collisionSubmitted.current = false;
    setSimulationRunning(true);
    setSimulationRunId((runId) => runId + 1);
  }

  function resetSimulation() {
    if (collisionRequestInProgress.current) return;
    setImpact(null);
    setSeverity("Waiting");
    setCollision(false);
    setSimulationRunning(false);
    setSpeedA(0);
    setSpeedB(0);
    setSimulationResetKey((key) => key + 1);
    collisionSubmitted.current = false;
    setAlertStatus("Standby");
  }

  const severityClass = severity.toLowerCase().replaceAll(" ", "-");
  return (
    <div className="app-shell">
      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <ShieldCheck size={23} />
          </div>
          <div>
            <h2>SafeDrive</h2>
            <span>ACCIDENT RESPONSE</span>
          </div>
        </div>

        <div className="nav-label">WORKSPACE</div>

        <div className="nav-item active">
          <Activity size={17} />
          Dashboard
        </div>
        <div className="nav-item">
          <AlertTriangle size={17} />
          Accident Events
        </div>
        <div className="nav-item">
          <Radio size={17} />
          Emergency Response
        </div>

        <div className="sidebar-bottom">
          <div className="system-indicator">
            <span className="online-dot" />
            Simulation active
          </div>
          <p>Academic project demo</p>
        </div>
      </aside>

      {/* MAIN DASHBOARD */}
      <main className="main-content">
            <header className="topbar">
              <div>
                <p className="eyebrow">SAFETY MONITORING / OVERVIEW</p>
                <h1>Command Center</h1>
                <p className="subtitle">
                  Monitor collisions, accident events and emergency response.
                </p>
              </div>

              <div className="status-pill">
                <span className="online-dot" />
                System Online
              </div>
            </header>

            {/* KPI CARDS */}
            <section className="stats-grid">
              <div className="stat-card">
                <div className="stat-icon blue">
                  <Activity size={19} />
                </div>
                <div>
                  <p>Total Accidents</p>
                  <h2>{accidentHistory.length}</h2>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-icon orange">
                  <Clock size={19} />
                </div>
                <div>
                  <p>Pending Queue</p>
                  <h2>{dsaLoading ? "--" : dsaStatus.queueSize}</h2>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-icon red">
                  <AlertTriangle size={19} />
                </div>
                <div>
                  <p>Severe Stack</p>
                  <h2>{dsaLoading ? "--" : dsaStatus.severeStackSize}</h2>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-icon green">
                  <ShieldCheck size={19} />
                </div>
                <div>
                  <p>Processed Events</p>
                  <h2>{dsaLoading ? "--" : dsaStatus.processedEvents}</h2>
                </div>
              </div>
            </section>

            {/* MAIN WORKSPACE */}
            <section className="workspace-grid">

              {/* COLLISION SIMULATOR */}
              <div className="panel simulation-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-kicker">SIMULATION MODULE</span>
                    <h2>3D Driving Simulator</h2>
                    <p>Drive the circuit, steer around traffic, and monitor collision events.</p>
                  </div>
                  <span className="demo-tag">DEMO MODE</span>
                </div>

                <AccidentGame
                  runId={simulationRunId}
                  resetKey={simulationResetKey}
                  onCollision={simulateCollision}
                  onRestart={resetSimulation}
                />

                <div className="control-section">
                  <div className="control-section-title">
                    <span>01</span>
                    Driving setup
                  </div>

                  <div className="driving-setup">
                    <div>
                      <span>Player start speed</span>
                      <strong>0 km/h</strong>
                    </div>
                    <div>
                      <span>AI traffic</span>
                      <strong>5 vehicles</strong>
                    </div>
                    <div>
                      <span>Track</span>
                      <strong>Multi-lane circuit</strong>
                    </div>
                  </div>
                </div>

                <div className="button-row">
                  <button
                    className="primary-button"
                    onClick={startSimulation}
                    disabled={simulationRunning || collision || alertStatus === "Processing"}
                  >
                    <Zap size={16} />
                    {alertStatus === "Processing"
                      ? "Processing..."
                      : simulationRunning
                        ? "Driving..."
                        : "Start Driving"}
                  </button>

                  <button
                    className="secondary-button"
                    onClick={resetSimulation}
                    disabled={alertStatus === "Processing"}
                  >
                    <RotateCcw size={15} />
                    Reset
                  </button>
                </div>

                <p className="simulation-note">
                  <AlertTriangle size={14} />
                  Educational simulation only. Not a validated crash prediction.
                </p>
              </div>

              {/* LIVE MAP */}
              <div className="panel map-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-kicker">LOCATION TRACKING</span>
                    <h2>Live Accident Map</h2>
                    <p>GPS, recorded accidents, and demo vehicle movement.</p>
                  </div>
                  <span className="event-count">LIVE MAP</span>
                </div>

                <MapContainer
                  center={[24.8607, 67.0011]}
                  zoom={11}
                  scrollWheelZoom={true}
                  style={{
                    height: "310px",
                    width: "100%",
                    borderRadius: "10px",
                    zIndex: 1,
                  }}
                >
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />

                  <FocusMapOnVehicle
                    vehicle={selectedVehicle}
                    request={mapFocusRequest}
                  />
                  <BrowserGPSMarker
                    onLocationFound={setGpsLocation}
                    onLocationError={setGpsError}
                  />

                  {/* Registered Vehicle GPS Markers */}
                  {vehicles.filter(hasVehicleLocation).map((vehicle) => (
                    <AnimatedVehicleMarker
                      key={vehicle.vehicleId}
                      vehicle={vehicle}
                    />
                  ))}

                  <SimulatedVehicleMarker
                    name="Vehicle A · Simulated"
                    position={simulatedPositions.vehicleA}
                    speed={speedA}
                    icon={simulatedVehicleIcons.vehicleA}
                  />
                  <SimulatedVehicleMarker
                    name="Vehicle B · Simulated"
                    position={simulatedPositions.vehicleB}
                    speed={speedB}
                    icon={simulatedVehicleIcons.vehicleB}
                  />

                  {accidentHistory
                    .filter(
                      (event) =>
                        event.hasLocation &&
                        event.latitude !== null &&
                        event.longitude !== null
                    )
                    .map((event) => (
                      <Marker
                        key={event.id}
                        position={[event.latitude, event.longitude]}
                      >
                        <Popup>
                          <strong>Accident #{event.id}</strong>
                          <br />
                          Severity: {event.severity}
                          <br />
                          Impact Score: {event.impactScore}
                          <br />
                          Status: {event.status}
                          <br />
                          Time: {event.timestamp}
                        </Popup>
                      </Marker>
                    ))}
                </MapContainer>

                <div className="map-legend">
                  <span><i className="legend-dot gps-dot" /> Browser GPS</span>
                  <span><i className="legend-dot vehicle-online-dot" /> Online vehicle</span>
                  <span><i className="legend-dot vehicle-offline-dot" /> Offline vehicle</span>
                  <span><i className="legend-dot simulation-a-dot" /> Demo A</span>
                  <span><i className="legend-dot simulation-b-dot" /> Demo B</span>
                  <span><i className="legend-dot accident-dot" /> Accident records</span>
                </div>
                <p className="simulated-gps-note">
                  Demo vehicle markers use simulated coordinates around Karachi, not actual GPS tracking.
                </p>

                <div className="gps-info">
                  <MapPin size={16} />
                  <div className="gps-info-details">
                    <strong>Current GPS position</strong>
                    <p>
                      {gpsLocation
                        ? `${gpsLocation[0].toFixed(5)}, ${gpsLocation[1].toFixed(5)}`
                        : gpsError || "Waiting for browser location permission..."}
                    </p>
                  </div>
                </div>

                <div className="registered-vehicles">
                  <div className="registered-vehicles-heading">
                    <strong>Registered Vehicles</strong>
                    <span>{vehicles.length} VEHICLES</span>
                  </div>

                  {vehicleError && (
                    <p className="vehicle-error" role="status">
                      {vehicleError}
                      {vehicles.length > 0 && " Showing the last received locations."}
                    </p>
                  )}
                  {vehicleLoading && vehicles.length === 0 ? (
                    <p className="vehicle-empty">Loading vehicles...</p>
                  ) : vehicles.length === 0 && !vehicleError ? (
                    <p className="vehicle-empty">
                      No registered vehicles found.
                    </p>
                  ) : vehicles.length > 0 ? (
                    <div className="vehicle-list">
                      {vehicles.map((vehicle) => {
                        const hasLocation = hasVehicleLocation(vehicle);
                        const speed = Number(vehicle.speed);
                        return (
                          <button
                            type="button"
                            className={`vehicle-list-item ${vehicle.vehicleId === selectedVehicleId ? "selected" : ""
                              }`}
                            key={vehicle.vehicleId}
                            disabled={!hasLocation}
                            onClick={() => {
                              setSelectedVehicleId(vehicle.vehicleId);
                              setMapFocusRequest((request) => request + 1);
                            }}
                            title={
                              hasLocation
                                ? `Focus map on ${vehicle.vehicleId}`
                                : "Waiting for this vehicle's first GPS update"
                            }
                          >
                            <div className="vehicle-list-icon">
                              <CarFront size={18} />
                            </div>

                            <div className="vehicle-list-details">
                              <strong>{vehicle.vehicleId}</strong>
                              <span>
                                {hasLocation && Number.isFinite(speed)
                                  ? `${speed.toFixed(1)} km/h`
                                  : "Speed unavailable"}
                              </span>
                              <small>
                                {hasLocation
                                  ? `${Number(vehicle.latitude).toFixed(5)}, ${Number(
                                    vehicle.longitude
                                  ).toFixed(5)}`
                                  : "Waiting for first GPS update"}
                              </small>
                              <small>Updated: {vehicle.lastUpdated}</small>
                            </div>

                            <span
                              className={`vehicle-status ${vehicle.isOnline ? "online" : "offline"
                                }`}
                            >
                              {vehicle.isOnline ? "ONLINE" : "OFFLINE"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

            {/* RESULTS AND WORKFLOW */}
            <section className="overview-grid">
              <div className="panel result-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-kicker">LATEST OUTPUT</span>
                    <h2>Detection Result</h2>
                  </div>
                  <Activity size={19} className="muted-icon" />
                </div>

                <div className={`severity-box ${severityClass}`}>
                  <div className="severity-symbol">
                    {severity === "Severe" ? (
                      <Siren size={25} />
                    ) : severity === "Waiting" ? (
                      <Clock size={25} />
                    ) : (
                      <AlertTriangle size={25} />
                    )}
                  </div>
                  <div>
                    <span>DETECTED SEVERITY</span>
                    <h3>{severity}</h3>
                  </div>
                </div>

                <div className="result-row">
                  <span>Impact score</span>
                  <strong>{impact === null ? "--" : `${impact}/100`}</strong>
                </div>
                <div className="result-row">
                  <span>Emergency alert</span>
                  <strong>{alertStatus}</strong>
                </div>
                <div className="result-row">
                  <span>GPS status</span>
                  <strong>{gpsLocation ? "Location available" : "Not available"}</strong>
                </div>

                <div className="response-message">
                  {severity === "Severe"
                    ? "High-priority demo alert generated."
                    : severity === "Moderate"
                      ? "Moderate-priority demo alert generated."
                      : severity === "Minor"
                        ? "Low-priority demo alert generated."
                        : severity === "No Accident"
                          ? "No accident alert generated."
                          : "Waiting for a collision simulation."}
                </div>
              </div>

              <div className="panel workflow-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-kicker">SYSTEM ACTIVITY</span>
                    <h2>Response Workflow</h2>
                    <p>Stages of the accident response process.</p>
                  </div>
                </div>

                <div className="workflow-step">
                  <span className="workflow-number">01</span>
                  <div>
                    <strong>Collision input</strong>
                    <p>Vehicle parameters received</p>
                  </div>
                  <span className="step-status">READY</span>
                </div>

                <div className="workflow-step">
                  <span className="workflow-number">02</span>
                  <div>
                    <strong>Severity analysis</strong>
                    <p>Backend calculates impact score</p>
                  </div>
                  <span className="step-status">
                    {impact === null ? "WAITING" : "DONE"}
                  </span>
                </div>

                <div className="workflow-step">
                  <span className="workflow-number">03</span>
                  <div>
                    <strong>Emergency response</strong>
                    <p>Demo alert status generated</p>
                  </div>
                  <span className="step-status">
                    {impact === null ? "WAITING" : "DONE"}
                  </span>
                </div>
              </div>
            </section>

            {/* ACCIDENT HISTORY */}
            <section className="panel history-panel">
              <div className="panel-heading">
                <div>
                  <span className="section-kicker">EVENT LOG</span>
                  <h2>Accident History</h2>
                  <p>Recorded collision events from the backend.</p>
                </div>
                <span className="event-count">
                  {accidentHistory.length} EVENTS
                </span>
              </div>

              {historyLoading ? (
                <div className="empty-state">
                  <Clock size={25} />
                  <p>Loading accident history...</p>
                </div>
              ) : historyError ? (
                <div className="empty-state">
                  <AlertTriangle size={25} />
                  <p>{historyError}</p>
                  <button className="secondary-button" onClick={fetchAccidentHistory}>
                    Retry
                  </button>
                </div>
              ) : accidentHistory.length === 0 ? (
                <div className="empty-state">
                  <Clock size={25} />
                  <p>No accident events yet.</p>
                  <span>Run a collision simulation to create an event record.</span>
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>EVENT</th>
                        <th>TIME</th>
                        <th>IMPACT SCORE</th>
                        <th>SEVERITY</th>
                        <th>RESPONSE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accidentHistory.map((event) => (
                        <tr key={event.id}>
                          <td>#{event.id}</td>
                          <td>{new Date(event.timestamp).toLocaleString()}</td>
                          <td>{event.impactScore}/100</td>
                          <td>
                            <span className={`event-badge ${event.severity.toLowerCase()}`}>
                              {event.severity}
                            </span>
                          </td>
                          <td>{event.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* DSA MONITORING */}
            <section className="panel dsa-monitor-panel">
              <div className="panel-heading">
                <div>
                  <span className="section-kicker">DATA STRUCTURES</span>
                  <h2>DSA Event Processing</h2>
                  <p>Monitor FIFO queue, LIFO stack and event processing.</p>
                </div>
                <span className="event-count">
                  TOTAL: {dsaStatus.totalEnqueuedEvents}
                </span>
              </div>

              {dsaError && <p className="dsa-error">{dsaError}</p>}

              <div className="dsa-summary">
                <div>
                  <span>Pending events</span>
                  <strong>{dsaStatus.queueSize}</strong>
                </div>
                <div>
                  <span>Severe events</span>
                  <strong>{dsaStatus.severeStackSize}</strong>
                </div>
                <div>
                  <span>Processed events</span>
                  <strong>{dsaStatus.processedEvents}</strong>
                </div>
                <div>
                  <span>Latest severe score</span>
                  <strong>
                    {dsaStatus.latestSevereEvent
                      ? `${dsaStatus.latestSevereEvent.impactScore}/100`
                      : "--"}
                  </strong>
                </div>
              </div>

              <button
                className="primary-button process-button"
                onClick={processNextAccident}
                disabled={dsaLoading || dsaStatus.queueSize === 0}
              >
                <Zap size={16} />
                Process Next Accident
              </button>

              <div className="dsa-structures-grid">
                {/* FIFO QUEUE */}
                <div className="dsa-box">
                  <div className="panel-heading">
                    <div>
                      <h3>Pending Queue</h3>
                      <p>FIFO · First In, First Out</p>
                    </div>
                    <span className="event-count">
                      {dsaStatus.queueEvents.length}
                    </span>
                  </div>

                  {dsaStatus.queueEvents.length === 0 ? (
                    <p className="empty-state">Queue is empty</p>
                  ) : (
                    <div className="dsa-event-list">
                      {dsaStatus.queueEvents.map((event, index) => (
                        <div className="dsa-event-card" key={event.id}>
                          <div className="dsa-event-header">
                            <strong>Event #{event.id}</strong>
                            <span>{index === 0 ? "FRONT" : "PENDING"}</span>
                          </div>
                          <p>Impact Score: {event.impactScore}/100</p>
                          <p>Severity: {event.severity}</p>
                          <small>{event.timestamp}</small>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* LIFO STACK */}
                <div className="dsa-box">
                  <div className="panel-heading">
                    <div>
                      <h3>Severe Accident Stack</h3>
                      <p>LIFO · Last In, First Out</p>
                    </div>
                    <span className="event-count">
                      {dsaStatus.stackEvents.length}
                    </span>
                  </div>

                  {dsaStatus.stackEvents.length === 0 ? (
                    <p className="empty-state">Stack is empty</p>
                  ) : (
                    <div className="dsa-event-list">
                      {dsaStatus.stackEvents.map((event, index) => (
                        <div className="dsa-event-card" key={event.id}>
                          <div className="dsa-event-header">
                            <strong>Event #{event.id}</strong>
                            <span>{index === 0 ? "TOP" : "BELOW"}</span>
                          </div>
                          <p>Impact Score: {event.impactScore}/100</p>
                          <p>Severity: {event.severity}</p>
                          <small>{event.timestamp}</small>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>

            <footer className="footer">
              <span>SafeDrive / Smart Accident Detection System</span>
              <span>Software-only academic prototype</span>
            </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
