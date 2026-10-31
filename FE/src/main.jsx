
import React, { useState, useEffect } from "react";
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

function App() {
  const [speedA, setSpeedA] = useState(60);
  const [speedB, setSpeedB] = useState(45);
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

  useEffect(() => {
    fetchAccidentHistory();
    fetchDsaStatus();
  }, []);

  async function simulateCollision() {
    setCollision(true);
    setAlertStatus("Processing");

    try {
      const response = await fetch(
        "http://localhost:8080/api/accident",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            speedA: Number(speedA),
            speedB: Number(speedB),
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
      setCollision(false);
      setAlertStatus("Backend connection failed");
      alert(
        "Could not connect to the C++ backend. " +
        "Make sure accident_backend.exe is running on port 8080."
      );
    }
  }


  function resetSimulation() {
    setImpact(null);
    setSeverity("Waiting");
    setCollision(false);
    setAlertStatus("Standby");
  }

  const severityClass = severity.toLowerCase().replaceAll(" ", "-");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <ShieldCheck size={26} />
          </div>
          <div>
            <h2>SafeDrive</h2>
            <span>ACCIDENT RESPONSE</span>
          </div>
        </div>

        <div className="nav-label">MAIN MENU</div>

        <div className="nav-item active">
          <Activity size={19} />
          Dashboard
        </div>

        <div className="nav-item">
          <CarFront size={19} />
          Vehicle Simulation
        </div>

        <div className="nav-item">
          <AlertTriangle size={19} />
          Accident Events
        </div>

        <div className="nav-item">
          <Radio size={19} />
          Emergency Response
        </div>

        <div className="sidebar-bottom">
          <div className="system-indicator">
            <span className="online-dot" />
            Software simulation active
          </div>
          <p>Academic project demo</p>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">MONITORING CENTER</p>
            <h1>Accident Detection Dashboard</h1>
            <p className="subtitle">
              Collision severity and emergency response simulation
            </p>
          </div>

          <div className="status-pill">
            <span className="online-dot" />
            System Online
          </div>
        </header>

        <section className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon blue">
              <Activity size={22} />
            </div>
            <div>
              <p>Impact Score</p>
              <h2>{impact === null ? "--" : `${impact}/100`}</h2>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon orange">
              <AlertTriangle size={22} />
            </div>
            <div>
              <p>Severity Level</p>
              <h2 className="stat-value">{severity}</h2>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon green">
              <ShieldCheck size={22} />
            </div>
            <div>
              <p>Emergency Status</p>
              <h2 className="stat-value">{alertStatus}</h2>
            </div>
          </div>
        </section>

        <section className="stats-grid dsa-stats-grid">
          <div className="stat-card">
            <div className="stat-icon blue">
              <Clock size={22} />
            </div>
            <div>
              <p>Pending Queue (FIFO)</p>
              <h2>{dsaLoading ? "--" : dsaStatus.queueSize}</h2>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon orange">
              <AlertTriangle size={22} />
            </div>
            <div>
              <p>Severe Stack (LIFO)</p>
              <h2>{dsaLoading ? "--" : dsaStatus.severeStackSize}</h2>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon green">
              <ShieldCheck size={22} />
            </div>
            <div>
              <p>Processed Events</p>
              <h2>{dsaLoading ? "--" : dsaStatus.processedEvents}</h2>
            </div>
          </div>
        </section>

        <section className="panel history-panel">
          <div className="panel-heading">
            <div>
              <h2>DSA Processing Status</h2>
              <p>Queue and Stack monitoring</p>
            </div>

            <span className="event-count">
              Total: {dsaStatus.totalEnqueuedEvents}
            </span>
          </div>

          {dsaError ? (
            <p className="empty-state">{dsaError}</p>
          ) : (
            <div>
              <div className="result-row">
                <span>Pending Queue</span>
                <strong>{dsaStatus.queueSize} events</strong>
              </div>

              <div className="result-row">
                <span>Severe Stack</span>
                <strong>{dsaStatus.severeStackSize} events</strong>
              </div>

              <div className="result-row">
                <span>Latest Severe Event</span>
                <strong>
                  {dsaStatus.latestSevereEvent
                    ? `${dsaStatus.latestSevereEvent.impactScore}/100`
                    : "None"}
                </strong>
              </div>
            </div>
          )}
          <button
            className="primary-button"
            onClick={processNextAccident}
            disabled={dsaLoading || dsaStatus.queueSize === 0}
          >
            <Zap size={18} />
            Process Next Accident
          </button>
        </section>


        {/* ACTUAL QUEUE AND STACK VISUALIZATION */}

        <section className="dsa-structures-grid">

          {/* PENDING QUEUE - FIFO */}
          <div className="panel">
            <div className="panel-heading">
              <div>
                <h2>Pending Queue</h2>
                <p>FIFO - First In, First Out</p>
              </div>
              <span className="event-count">
                {dsaStatus.queueEvents.length} Events
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

          {/* SEVERE STACK - LIFO */}
          <div className="panel">
            <div className="panel-heading">
              <div>
                <h2>Severe Accident Stack</h2>
                <p>LIFO - Last In, First Out</p>
              </div>
              <span className="event-count">
                {dsaStatus.stackEvents.length} Events
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

        </section>


        <section className="content-grid">
          <div className="panel simulation-panel">
            <div className="panel-heading">
              <div>
                <h2>Vehicle Collision Simulation</h2>
                <p>Adjust speeds and simulate an impact</p>
              </div>
              <span className="demo-tag">DEMO MODE</span>
            </div>

            <div className={`collision-scene ${collision ? "collided" : ""}`}>
              <div className="road-line" />

              <div className="vehicle vehicle-a">
                <CarFront size={48} strokeWidth={1.5} />
                <span>VEHICLE A</span>
              </div>

              <div className="impact-marker">
                {collision ? (
                  <Zap size={38} />
                ) : (
                  <span>VS</span>
                )}
              </div>

              <div className="vehicle vehicle-b">
                <CarFront size={48} strokeWidth={1.5} />
                <span>VEHICLE B</span>
              </div>
            </div>

            <div className="speed-controls">
              <div className="speed-control">
                <div className="speed-label">
                  <span>Vehicle A Speed</span>
                  <strong>{speedA} km/h</strong>
                </div>
                <input
                  aria-label="Vehicle A speed"
                  type="range"
                  min="0"
                  max="120"
                  value={speedA}
                  onChange={(e) => {
                    setSpeedA(Number(e.target.value));
                    setCollision(false);
                  }}
                />
                <div className="range-labels">
                  <span>0 km/h</span>
                  <span>120 km/h</span>
                </div>
              </div>

              <div className="speed-control">
                <div className="speed-label">
                  <span>Vehicle B Speed</span>
                  <strong>{speedB} km/h</strong>
                </div>
                <input
                  aria-label="Vehicle B speed"
                  type="range"
                  min="0"
                  max="120"
                  value={speedB}
                  onChange={(e) => {
                    setSpeedB(Number(e.target.value));
                    setCollision(false);
                  }}
                />
                <div className="range-labels">
                  <span>0 km/h</span>
                  <span>120 km/h</span>
                </div>
              </div>
            </div>

            <div className="button-row">
              <button className="primary-button" onClick={simulateCollision}>
                <Zap size={18} />
                Simulate Collision
              </button>

              <button className="secondary-button" onClick={resetSimulation}>
                <RotateCcw size={17} />
                Reset
              </button>
            </div>

            <p className="simulation-note">
              <AlertTriangle size={15} />
              Simulated values only; this is not a validated crash prediction.
            </p>
          </div>

          <div className="right-column">
            <div className="panel result-panel">
              <div className="panel-heading">
                <div>
                  <h2>Detection Result</h2>
                  <p>Latest simulation output</p>
                </div>
                <Activity size={21} className="muted-icon" />
              </div>

              <div className={`severity-box ${severityClass}`}>
                <div className="severity-symbol">
                  {severity === "Severe" ? (
                    <Siren size={28} />
                  ) : severity === "Waiting" ? (
                    <Clock size={28} />
                  ) : (
                    <AlertTriangle size={28} />
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
                <span>Location</span>
                <strong className="location-value">
                  <MapPin size={15} />
                  Demo location
                </strong>
              </div>

              <div className="result-row">
                <span>Emergency alert</span>
                <strong>{alertStatus}</strong>
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
                  <h2>Response Workflow</h2>
                  <p>Simulated system stages</p>
                </div>
              </div>

              <div className="workflow-step">
                <span className="workflow-number">1</span>
                <div>
                  <strong>Collision input</strong>
                  <p>Vehicle speeds received</p>
                </div>
                <span className="step-status">READY</span>
              </div>

              <div className="workflow-step">
                <span className="workflow-number">2</span>
                <div>
                  <strong>Severity analysis</strong>
                  <p>Demo score calculated</p>
                </div>
                <span className="step-status">
                  {impact === null ? "WAITING" : "DONE"}
                </span>
              </div>

              <div className="workflow-step">
                <span className="workflow-number">3</span>
                <div>
                  <strong>Emergency response</strong>
                  <p>No real messages sent</p>
                </div>
                <span className="step-status">
                  {impact === null ? "WAITING" : "DONE"}
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="panel history-panel">
          <div className="panel-heading">
            <div>
              <h2>Recent Accident Events</h2>
              <p>Latest simulated accident records</p>
            </div>
            <span className="event-count">
              {accidentHistory.length} events
            </span>
          </div>

          {historyLoading ? (
            <div className="empty-state">
              <Clock size={28} />
              <p>Loading accident history...</p>
            </div>
          ) : historyError ? (
            <div className="empty-state">
              <AlertTriangle size={28} />
              <p>{historyError}</p>
              <button onClick={fetchAccidentHistory}>
                Retry
              </button>
            </div>
          ) : accidentHistory.length === 0 ? (
            <div className="empty-state">
              <Clock size={28} />
              <p>No accident events yet.</p>
              <span>Run a collision simulation to create an event record.</span>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Impact Score</th>
                    <th>Severity</th>
                    <th>Response</th>
                  </tr>
                </thead>

                <tbody>
                  {accidentHistory.map((event) => (
                    <tr key={event.id}>
                      <td>{new Date(event.timestamp).toLocaleString()}</td>
                      <td>{event.impactScore}/100</td>
                      <td>
                        <span
                          className={`event-badge ${event.severity.toLowerCase()}`}
                        >
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

        <footer className="footer">
          <span>SafeDrive · Smart Accident Detection System</span>
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
