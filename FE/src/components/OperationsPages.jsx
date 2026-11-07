import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  BellRing,
  CameraOff,
  CheckCircle2,
  Download,
  FileWarning,
  MapPin,
  RefreshCw,
  Search,
  ShieldAlert,
  Waypoints,
} from "lucide-react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";

const CLASSIFICATIONS = [
  "potential_accident",
  "suspected_accident",
  "confirmed_accident",
];
const EVIDENCE_LABELS = {
  vehicle_proximity: "Vehicle proximity",
  bounding_box_overlap: "Bounding-box overlap",
  sudden_deceleration: "Sudden-deceleration indicator",
  abrupt_direction_change: "Abrupt direction-change indicator",
  stopped_after_possible_collision: "Sustained stop after interaction",
};

function hasIncidentLocation(event) {
  const latitude = Number(event?.latitude);
  const longitude = Number(event?.longitude);
  return (
    event?.hasLocation === true &&
    event.latitude !== null &&
    event.longitude !== null &&
    event.latitude !== "" &&
    event.longitude !== "" &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function formatTime(value) {
  if (!value) return "Timestamp unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function dayValue(value) {
  if (typeof value !== "string") return "";
  const isoDate = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDate) return isoDate[1];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function eventName(event) {
  return event.eventId || (event.id !== undefined ? `#${event.id}` : "ID unavailable");
}

function normalizedSeverity(event) {
  return String(event?.severity || "").toLowerCase();
}

function countSeverities(events) {
  return events.reduce(
    (counts, event) => {
      const severity = normalizedSeverity(event);
      if (severity === "severe" || severity === "critical") counts.severe += 1;
      else if (severity === "moderate") counts.moderate += 1;
      else if (severity === "minor") counts.minor += 1;
      return counts;
    },
    { severe: 0, moderate: 0, minor: 0 }
  );
}

function eventClass(event) {
  const type = String(event?.eventType || "");
  if (CLASSIFICATIONS.includes(type)) return type.replace("_accident", "");
  return "backend-record";
}

function recordSource(event) {
  if (CLASSIFICATIONS.includes(event?.eventType)) return "AI-assisted visual indicator";
  return "Backend record · source not specified";
}

function SeverityTag({ severity }) {
  const className = normalizedSeverity({ severity }).replace(/[^a-z-]/g, "") || "unknown";
  return <span className={`severity-tag ${className}`}>{severity || "Severity unavailable"}</span>;
}

function PagePanel({ title, description, actions, children, className = "" }) {
  return (
    <section className={`workspace-panel ${className}`}>
      <div className="workspace-panel-heading">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function LoadingError({ loading, error, onRetry, emptyText }) {
  if (loading) {
    return <div className="workspace-state"><RefreshCw size={18} /><span>Loading backend records…</span></div>;
  }
  if (error) {
    return (
      <div className="workspace-state error" role="alert">
        <AlertCircle size={18} />
        <span>{error}</span>
        {onRetry && <button type="button" className="text-button" onClick={onRetry}>Retry</button>}
      </div>
    );
  }
  if (emptyText) {
    return <div className="workspace-state"><FileWarning size={18} /><span>{emptyText}</span></div>;
  }
  return null;
}

export function OverviewPage({
  history,
  historyLoading,
  historyError,
  dsaStatus,
  dsaLoading,
  backendStatus,
  aiStatus,
  onNavigate,
  onRefresh,
}) {
  const counts = countSeverities(history);
  const metrics = [
    { label: "Backend records", value: historyLoading || historyError ? "—" : history.length, tone: "blue" },
    { label: "Severe", value: historyLoading || historyError ? "—" : counts.severe, tone: "red" },
    { label: "Moderate", value: historyLoading || historyError ? "—" : counts.moderate, tone: "amber" },
    { label: "Minor", value: historyLoading || historyError ? "—" : counts.minor, tone: "green" },
    {
      label: "Pending events",
      value: dsaLoading || backendStatus !== "online" ? "—" : dsaStatus.pendingEvents ?? dsaStatus.queueSize,
      tone: "violet",
    },
  ];
  const recent = [...history].slice(-6).reverse();

  return (
    <div className="page-stack">
      <div className="truth-banner">
        <ShieldAlert size={18} />
        <p><strong>Evidence note:</strong> totals are backend records, not independently verified crash counts. Video-only AI events remain indicators.</p>
        <button type="button" className="text-button" onClick={onRefresh}>Refresh data</button>
      </div>

      <section className="metric-grid" aria-label="Backend incident summaries">
        {metrics.map((metric) => (
          <article className={`metric-card ${metric.tone}`} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.label === "Backend records" ? "C++ history endpoint" : "Current backend snapshot"}</small>
          </article>
        ))}
      </section>

      <div className="overview-columns">
        <PagePanel
          title="Recent backend activity"
          description="Latest records returned by GET /api/accidents/history."
          actions={<button type="button" className="text-button" onClick={() => onNavigate("history")}>View history</button>}
        >
          {historyLoading || historyError || recent.length === 0 ? (
            <LoadingError
              loading={historyLoading}
              error={historyError}
              onRetry={onRefresh}
              emptyText="No backend incident records are available."
            />
          ) : (
            <div className="activity-list">
              {recent.map((event) => (
                <article className="activity-row" key={event.id ?? event.eventId}>
                  <span className={`activity-mark ${eventClass(event)}`} />
                  <div className="activity-main">
                    <strong>{eventName(event)}</strong>
                    <span>{event.eventType || "Event type unavailable"} · {formatTime(event.timestamp)}</span>
                  </div>
                  <SeverityTag severity={event.severity} />
                </article>
              ))}
            </div>
          )}
        </PagePanel>

        <PagePanel title="Service health" description="Connectivity is checked against the configured APIs.">
          <div className="health-list">
            <div><span>C++ backend</span><strong className={`state-text ${backendStatus}`}>{backendStatus}</strong></div>
            <div><span>AI analysis service</span><strong className={`state-text ${aiStatus.connection}`}>{aiStatus.connection}</strong></div>
            <div><span>Queue processing</span><strong>{dsaLoading ? "Checking" : dsaStatus.processingStatus || "Unavailable"}</strong></div>
          </div>
          <div className="page-quick-actions">
            <button type="button" className="quiet-button" onClick={() => onNavigate("live")}>Open live monitoring</button>
            <button type="button" className="quiet-button" onClick={() => onNavigate("ai")}>Open AI studio</button>
          </div>
        </PagePanel>
      </div>
    </div>
  );
}

export function LiveMonitoringPage({
  aiStatus,
  backendStatus,
  vehicles,
  vehicleStatus,
  dsaStatus,
  onNavigate,
  onRefreshVehicles,
}) {
  const recentAiEvents = (dsaStatus.historyEvents || [])
    .filter((event) => CLASSIFICATIONS.includes(event.eventType))
    .slice(-5)
    .reverse();

  return (
    <div className="page-stack">
      <div className="live-source-grid">
        <PagePanel title="Camera feed" description="No live CCTV or camera source is configured.">
          <div className="camera-empty">
            <CameraOff size={34} />
            <strong>No live camera configured</strong>
            <span>Upload a supported video in the AI Analysis Studio to run YOLO + ByteTrack. No live feed is simulated here.</span>
            <button type="button" className="primary-action" onClick={() => onNavigate("ai")}>Open AI Analysis Studio</button>
          </div>
        </PagePanel>

        <PagePanel
          title="Service and tracking status"
          description="Registration data is not the same as active video tracks."
          actions={<button type="button" className="icon-action compact" onClick={onRefreshVehicles}><RefreshCw size={15} /><span>Refresh records</span></button>}
        >
          <div className="source-status-list">
            <div><span>AI service</span><strong className={`state-text ${aiStatus.connection}`}>{aiStatus.connection}</strong></div>
            <div><span>AI processing</span><strong>{aiStatus.connection === "online" ? aiStatus.processingStatus || "Idle" : "Unavailable"}</strong></div>
            <div><span>C++ backend</span><strong className={`state-text ${backendStatus}`}>{backendStatus}</strong></div>
            <div><span>Video tracking IDs</span><strong>Only available after video analysis</strong></div>
          </div>
          <p className="subtle-note">
            {vehicleStatus === "online"
              ? `${vehicles.length} registered vehicle record${vehicles.length === 1 ? "" : "s"} returned by the backend; these are not ByteTrack detections.`
              : "The registered-vehicles endpoint is unavailable; no vehicle records are shown."}
          </p>
        </PagePanel>
      </div>

      <PagePanel title="Recent AI-assisted event records" description="Potential and suspected classifications remain unconfirmed visual indicators.">
        {recentAiEvents.length === 0 ? (
          <div className="workspace-state"><FileWarning size={18} /><span>No potential or suspected AI event records are available from the backend.</span></div>
        ) : (
          <div className="activity-list">
            {recentAiEvents.map((event) => (
              <article className="activity-row" key={event.id ?? event.eventId}>
                <AlertTriangle size={17} className="warning-icon" />
                <div className="activity-main">
                  <strong>{eventName(event)} · {event.eventType}</strong>
                  <span>{formatTime(event.timestamp)} · {event.vehicleIds?.length ? `Vehicle IDs ${event.vehicleIds.join(", ")}` : "Vehicle IDs unavailable"}</span>
                </div>
                <span className="classification-note">AI-assisted indicator</span>
              </article>
            ))}
          </div>
        )}
      </PagePanel>
    </div>
  );
}

function incidentIcon(event) {
  const severity = normalizedSeverity(event).replace(/[^a-z-]/g, "") || "unknown";
  return L.divIcon({
    className: "incident-marker-shell",
    html: `<span class="incident-map-pin ${severity}" aria-hidden="true"></span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -10],
  });
}

function locationGroups(events) {
  const groups = new Map();
  for (const event of events) {
    if (!hasIncidentLocation(event)) continue;
    const latitude = Number(event.latitude);
    const longitude = Number(event.longitude);
    const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    const group = groups.get(key) || { key, latitude: 0, longitude: 0, events: [] };
    group.latitude += latitude;
    group.longitude += longitude;
    group.events.push(event);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.events.length > 1)
    .map((group) => ({
      ...group,
      latitude: group.latitude / group.events.length,
      longitude: group.longitude / group.events.length,
    }))
    .sort((a, b) => b.events.length - a.events.length);
}

export function IncidentCenterPage({ history, historyLoading, historyError, onRefresh }) {
  const [selectedId, setSelectedId] = useState(null);
  const [severityFilter, setSeverityFilter] = useState("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const mapped = history.filter(hasIncidentLocation);
  const filtered = mapped.filter((event) => {
    const severityMatch = severityFilter === "all" || event.severity === severityFilter;
    const date = dayValue(event.timestamp);
    const dateMatch = (!startDate && !endDate) || Boolean(
      date && (!startDate || date >= startDate) && (!endDate || date <= endDate)
    );
    return severityMatch && dateMatch;
  });
  const selected = filtered.find((event) => event.id === selectedId) || filtered[0] || null;
  const hotspots = locationGroups(filtered);
  const severityOptions = [...new Set(history.map((event) => event.severity).filter(Boolean))].sort();

  return (
    <div className="page-stack">
      <div className="truth-banner">
        <MapPin size={18} />
        <p>Markers use coordinates returned with backend records only. Browser GPS and camera location are not substituted for incident location.</p>
      </div>
      <PagePanel
        title="Incident map"
        description="OpenStreetMap tiles · markers include only valid backend incident coordinates."
        actions={<button type="button" className="icon-action compact" onClick={onRefresh}><RefreshCw size={15} /><span>Refresh</span></button>}
      >
        <div className="filter-toolbar">
          <label>Severity
            <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)}>
              <option value="all">All severities</option>
              {severityOptions.map((severity) => <option key={severity}>{severity}</option>)}
            </select>
          </label>
          <label>From
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label>To
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </label>
          <span className="filter-count">{filtered.length} located record{filtered.length === 1 ? "" : "s"}</span>
        </div>
        {historyLoading || historyError ? (
          <LoadingError loading={historyLoading} error={historyError} onRetry={onRefresh} />
        ) : mapped.length === 0 ? (
          <div className="location-unavailable">
            <MapPin size={25} />
            <strong>Location unavailable</strong>
            <span>No backend incident record contains valid GPS coordinates. The map is not centered on a default location.</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="location-unavailable"><span>No located records match the selected filters.</span></div>
        ) : (
          <div className="incident-map-layout">
            <MapContainer
              key={`${filtered[0].latitude}-${filtered[0].longitude}`}
              center={[Number(filtered[0].latitude), Number(filtered[0].longitude)]}
              zoom={12}
              scrollWheelZoom
              className="incident-map"
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {filtered.map((event) => (
                <Marker
                  key={event.id ?? event.eventId}
                  position={[Number(event.latitude), Number(event.longitude)]}
                  icon={incidentIcon(event)}
                  eventHandlers={{ click: () => setSelectedId(event.id) }}
                >
                  <Popup>
                    <strong>{eventName(event)}</strong><br />
                    {event.severity || "Severity unavailable"} · {event.eventType || "Type unavailable"}<br />
                    {formatTime(event.timestamp)}
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
            <aside className="incident-detail">
              <span className="section-label">SELECTED RECORD</span>
              {selected ? (
                <>
                  <h3>{eventName(selected)}</h3>
                  <SeverityTag severity={selected.severity} />
                  <dl>
                    <dt>Event type</dt><dd>{selected.eventType || "Not provided"}</dd>
                    <dt>Record source</dt><dd>{recordSource(selected)}</dd>
                    <dt>Timestamp</dt><dd>{formatTime(selected.timestamp)}</dd>
                    <dt>Coordinates</dt><dd>{Number(selected.latitude).toFixed(6)}, {Number(selected.longitude).toFixed(6)}</dd>
                    <dt>Processing</dt><dd>{selected.status || "Not provided"}</dd>
                    <dt>Evidence</dt><dd>{Array.isArray(selected.evidence) && selected.evidence.length ? selected.evidence.map((item) => EVIDENCE_LABELS[item.type] || item.type).join(", ") : "Not provided"}</dd>
                  </dl>
                </>
              ) : <p>Select a map marker to view its record.</p>}
            </aside>
          </div>
        )}
      </PagePanel>

      <div className="overview-columns">
        <PagePanel title="Repeated-record areas" description="Approximate coordinate cells, not road-level blackspot claims. Cells require at least two located records.">
          {hotspots.length === 0 ? (
            <div className="workspace-state"><FileWarning size={18} /><span>Insufficient repeated GPS records to show a location cluster.</span></div>
          ) : (
            <div className="activity-list">
              {hotspots.map((group) => (
                <article className="activity-row" key={group.key}>
                  <MapPin size={17} className="map-icon" />
                  <div className="activity-main">
                    <strong>{group.events.length} records in an approximate 0.01° coordinate cell</strong>
                    <span>{group.latitude.toFixed(4)}, {group.longitude.toFixed(4)} · No road name inferred</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </PagePanel>
        <PagePanel title="Nearby emergency facilities" description="No facility source is configured.">
          <div className="location-unavailable compact-state">
            <AlertCircle size={20} />
            <span>Facility data unavailable. No hospitals or emergency services are shown without a verified facility data source.</span>
          </div>
        </PagePanel>
      </div>
    </div>
  );
}

function aggregateBy(events, getKey) {
  return events.reduce((result, event) => {
    const keys = getKey(event);
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (key) result.set(key, (result.get(key) || 0) + 1);
    }
    return result;
  }, new Map());
}

export function AnalyticsPage({ history, historyLoading, historyError, dsaStatus, dsaLoading, dsaError, vehicles, vehicleStatus, onRefresh }) {
  const severityCounts = countSeverities(history);
  const typeCounts = aggregateBy(history, (event) => event.eventType || "Not provided");
  const evidenceCounts = aggregateBy(
    history,
    (event) => Array.isArray(event.evidence) ? event.evidence.map((item) => item.type) : []
  );
  const dailyCounts = aggregateBy(history, (event) => dayValue(event.timestamp));
  const maxDaily = Math.max(1, ...dailyCounts.values());
  const classificationCounts = CLASSIFICATIONS.map((classification) => ({
    classification,
    count: history.filter((event) => event.eventType === classification).length,
  }));
  const clusters = locationGroups(history);

  return (
    <div className="page-stack">
      <PagePanel
        title="Recorded incident statistics"
        description="All values are descriptive counts from the backend history response."
        actions={<button type="button" className="icon-action compact" onClick={onRefresh}><RefreshCw size={15} /><span>Refresh</span></button>}
      >
        {historyLoading || historyError ? (
          <LoadingError loading={historyLoading} error={historyError} onRetry={onRefresh} />
        ) : (
          <>
            <div className="metric-grid compact-grid">
              <article className="metric-card blue"><span>Total records</span><strong>{history.length}</strong><small>Backend history</small></article>
              <article className="metric-card red"><span>Severe</span><strong>{severityCounts.severe}</strong><small>Recorded severity</small></article>
              <article className="metric-card amber"><span>Moderate</span><strong>{severityCounts.moderate}</strong><small>Recorded severity</small></article>
              <article className="metric-card green"><span>Minor</span><strong>{severityCounts.minor}</strong><small>Recorded severity</small></article>
              <article className="metric-card violet"><span>Pending</span><strong>{dsaLoading || dsaError ? "—" : dsaStatus.pendingEvents ?? dsaStatus.queueSize ?? "—"}</strong><small>Current C++ queue</small></article>
              <article className="metric-card blue"><span>Processed</span><strong>{dsaLoading || dsaError ? "—" : dsaStatus.totalProcessedEvents ?? dsaStatus.processedEvents ?? "—"}</strong><small>Current C++ process count</small></article>
            </div>
            {history.length === 0 && <div className="workspace-state"><FileWarning size={18} /><span>No records are available for analytics.</span></div>}
          </>
        )}
      </PagePanel>

      <div className="overview-columns">
        <PagePanel title="Date trend" description="Counts grouped by calendar date where the timestamp contains a usable date.">
          {dailyCounts.size === 0 ? <div className="workspace-state"><span>No dated records are available.</span></div> : (
            <div className="trend-list">
              {[...dailyCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-14).map(([day, count]) => (
                <div className="trend-row" key={day}>
                  <span>{day}</span>
                  <div className="trend-track"><i style={{ width: `${(count / maxDaily) * 100}%` }} /></div>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
          )}
        </PagePanel>
        <PagePanel title="AI event classifications" description="Classification labels are reported as stored; video-only analysis is not proof of a crash.">
          <div className="classification-list">
            {classificationCounts.map(({ classification, count }) => (
              <div key={classification}><span>{classification.replaceAll("_", " ")}</span><strong>{count}</strong></div>
            ))}
            {[...typeCounts.entries()]
              .filter(([type]) => !CLASSIFICATIONS.includes(type))
              .map(([type, count]) => <div key={type}><span>{type}</span><strong>{count}</strong></div>)}
          </div>
        </PagePanel>
      </div>

      <div className="overview-columns">
        <PagePanel title="Available traffic indicators" description="Indicators are counts from event evidence, not proof of a collision.">
          {evidenceCounts.size === 0 ? (
            <div className="workspace-state"><Waypoints size={18} /><span>No event evidence metadata is available.</span></div>
          ) : (
            <div className="classification-list">
              {[...evidenceCounts.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                <div key={type}><span>{EVIDENCE_LABELS[type] || type}</span><strong>{count}</strong></div>
              ))}
            </div>
          )}
          <p className="subtle-note">
            {vehicleStatus === "online"
              ? `Backend vehicle registrations available: ${vehicles.length}. This is not a live detector count.`
              : "Vehicle registration counts unavailable."}
          </p>
        </PagePanel>
        <PagePanel title="Predictive collision warning · preparation only" description="No predictive warnings are generated.">
          <ul className="requirements-list">
            <li>Camera geometry and real-world distance calibration</li>
            <li>Validated speed and direction measurements over time</li>
            <li>Reliable synchronized multi-vehicle track histories</li>
            <li>Labeled evaluation footage and safety review before deployment</li>
          </ul>
          <p className="subtle-note">Uncalibrated image-space motion is not sufficient for reliable time-to-collision estimates.</p>
        </PagePanel>
      </div>

      <PagePanel title="Approximate GPS clusters" description="Grouped in 0.01° cells; no road names or blackspots are inferred.">
        {clusters.length === 0 ? (
          <div className="workspace-state"><MapPin size={18} /><span>Insufficient repeated GPS records to identify a location cluster.</span></div>
        ) : (
          <div className="classification-list">
            {clusters.map((cluster) => (
              <div key={cluster.key}><span>{cluster.latitude.toFixed(4)}, {cluster.longitude.toFixed(4)}</span><strong>{cluster.events.length} records</strong></div>
            ))}
          </div>
        )}
      </PagePanel>
    </div>
  );
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadReport(events) {
  const columns = [
    ["id", "ID"],
    ["eventId", "Event ID"],
    ["severity", "Severity"],
    ["impactScore", "Impact score"],
    ["eventType", "Event type"],
    ["timestamp", "Timestamp"],
    ["status", "Processing status"],
    ["location", "Coordinates"],
    ["confidence", "Confidence"],
    ["vehicleIds", "Vehicle IDs"],
    ["evidence", "Evidence"],
  ];
  const rows = [
    columns.map(([, label]) => csvCell(label)).join(","),
    ...events.map((event) => columns.map(([field]) => {
      if (field === "location") return csvCell(hasIncidentLocation(event) ? `${event.latitude}, ${event.longitude}` : "");
      if (field === "vehicleIds" || field === "evidence") return csvCell(JSON.stringify(event[field] ?? []));
      return csvCell(event[field]);
    }).join(",")),
  ];
  const blob = new Blob([rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "incident-history.csv";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function HistoryPage({ history, historyLoading, historyError, onRefresh }) {
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState("all");
  const [eventType, setEventType] = useState("all");
  const [status, setStatus] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [sort, setSort] = useState("newest");

  const eventTypes = useMemo(
    () => [...new Set(history.map((event) => event.eventType).filter(Boolean))].sort(),
    [history]
  );
  const severities = useMemo(
    () => [...new Set(history.map((event) => event.severity).filter(Boolean))].sort(),
    [history]
  );
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return history.filter((event) => {
      const idMatch = !query ||
        String(event.eventId || "").toLowerCase().includes(query) ||
        String(event.id ?? "").toLowerCase().includes(query);
      const severityMatch = severity === "all" || event.severity === severity;
      const typeMatch = eventType === "all" || event.eventType === eventType;
      const statusMatch = status === "all" || event.status === status;
      const date = dayValue(event.timestamp);
      const dateMatch = (!fromDate && !toDate) || Boolean(
        date && (!fromDate || date >= fromDate) && (!toDate || date <= toDate)
      );
      return idMatch && severityMatch && typeMatch && statusMatch && dateMatch;
    }).sort((a, b) => {
      if (sort === "impact-high") return Number(b.impactScore || 0) - Number(a.impactScore || 0);
      if (sort === "impact-low") return Number(a.impactScore || 0) - Number(b.impactScore || 0);
      const dateA = Date.parse(a.timestamp);
      const dateB = Date.parse(b.timestamp);
      if (Number.isFinite(dateA) && Number.isFinite(dateB)) {
        return sort === "oldest" ? dateA - dateB : dateB - dateA;
      }
      return sort === "oldest" ? Number(a.id || 0) - Number(b.id || 0) : Number(b.id || 0) - Number(a.id || 0);
    });
  }, [eventType, fromDate, history, search, severity, sort, status, toDate]);

  return (
    <div className="page-stack">
      <PagePanel
        title="Incident history"
        description="Search and filter backend records. Missing metadata is shown as unavailable."
        actions={
          <div className="panel-actions">
            <button type="button" className="icon-action compact" onClick={onRefresh}><RefreshCw size={15} /><span>Refresh</span></button>
            <button type="button" className="icon-action compact" onClick={() => downloadReport(filtered)} disabled={filtered.length === 0}><Download size={15} /><span>Export CSV</span></button>
          </div>
        }
      >
        <div className="history-filter-grid">
          <label className="search-control"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search event ID" aria-label="Search event ID" /></label>
          <label>Severity<select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="all">All</option>{severities.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Event type<select value={eventType} onChange={(event) => setEventType(event.target.value)}><option value="all">All</option>{eventTypes.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All</option><option>Pending</option><option>Processed</option></select></label>
          <label>From<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
          <label>To<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
          <label>Sort<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Timestamp · newest</option><option value="oldest">Timestamp · oldest</option><option value="impact-high">Impact · highest</option><option value="impact-low">Impact · lowest</option></select></label>
          <span className="filter-count">{filtered.length} / {history.length} records</span>
        </div>
        {historyLoading || historyError ? (
          <LoadingError loading={historyLoading} error={historyError} onRetry={onRefresh} />
        ) : filtered.length === 0 ? (
          <div className="workspace-state"><FileWarning size={18} /><span>{history.length ? "No records match the selected filters." : "No backend incident records are available."}</span></div>
        ) : (
          <div className="responsive-table">
            <table className="incident-table">
              <thead><tr><th>Event ID</th><th>Timestamp</th><th>Classification</th><th>Severity</th><th>Impact</th><th>Location</th><th>Status</th><th>Evidence</th></tr></thead>
              <tbody>{filtered.map((event) => (
                <tr key={event.id ?? event.eventId}>
                  <td><strong>{eventName(event)}</strong></td>
                  <td>{formatTime(event.timestamp)}</td>
                  <td>{event.eventType || "Not provided"}</td>
                  <td><SeverityTag severity={event.severity} /></td>
                  <td>{event.impactScore === null || event.impactScore === undefined ? "Not provided" : event.impactScore}</td>
                  <td>{hasIncidentLocation(event) ? `${Number(event.latitude).toFixed(5)}, ${Number(event.longitude).toFixed(5)}` : "Location unavailable"}</td>
                  <td>{event.status || "Not provided"}</td>
                  <td>{Array.isArray(event.evidence) && event.evidence.length ? event.evidence.map((item) => EVIDENCE_LABELS[item.type] || item.type).join(", ") : "Not provided"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="subtle-note">CSV export includes the filtered backend records only. No missing coordinates or confidence values are inferred.</p>
      </PagePanel>
    </div>
  );
}

export function SettingsPage({
  backendStatus,
  aiStatus,
  vehicleStatus,
  notificationStatus,
  backendUrl,
  aiUrl,
  notificationUrl,
}) {
  const [gpsPermission, setGpsPermission] = useState("Checking browser support…");

  useEffect(() => {
    let active = true;
    if (!navigator.permissions?.query) {
      setGpsPermission("Permission status unavailable; location has not been requested.");
      return undefined;
    }
    navigator.permissions.query({ name: "geolocation" })
      .then((permission) => {
        if (active) setGpsPermission(`Browser permission: ${permission.state}. This is not incident GPS.`);
      })
      .catch(() => {
        if (active) setGpsPermission("Permission status unavailable; location has not been requested.");
      });
    return () => { active = false; };
  }, []);

  const rows = [
    ["C++ backend", backendStatus, `${backendUrl}/api/dsa/status`],
    ["Python AI service", aiStatus.connection, `${aiUrl}/api/ai/status`],
    ["Camera source", "not configured", "No live camera stream endpoint is configured"],
    ["Browser location permission", "information only", gpsPermission],
    ["Map tiles", "configured", "OpenStreetMap standard tile endpoint"],
    ["Notification service", notificationStatus, `${notificationUrl}/api/health`],
  ];
  return (
    <div className="page-stack">
      <PagePanel title="Service configuration" description="Connection details are informational; no credentials or secret environment values are displayed.">
        <div className="settings-list">
          {rows.map(([label, status, detail]) => (
            <article className="settings-row" key={label}>
              <div className="settings-row-icon"><CheckCircle2 size={17} /></div>
              <div className="settings-row-body"><strong>{label}</strong><span>{detail}</span></div>
              <span className={`settings-state ${["online", "configured"].includes(status) ? "good" : status === "checking" ? "pending" : "muted"}`}>{status}</span>
            </article>
          ))}
        </div>
      </PagePanel>
      <div className="truth-banner">
        <BellRing size={18} />
        <p>The notification service reports connectivity only. This dashboard does not contact emergency services or claim that a provider delivered a message.</p>
      </div>
    </div>
  );
}
