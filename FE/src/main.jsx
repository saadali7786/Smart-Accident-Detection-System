import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BarChart3,
  BellRing,
  BrainCircuit,
  Camera,
  Clock3,
  LayoutDashboard,
  MapPinned,
  RefreshCw,
  Settings,
  ShieldCheck,
  Waypoints,
} from "lucide-react";
import AIDetection from "./components/AIDetection";
import DSAMonitoring from "./components/DSAMonitoring";
import {
  AnalyticsPage,
  HistoryPage,
  IncidentCenterPage,
  LiveMonitoringPage,
  OverviewPage,
  SettingsPage,
} from "./components/OperationsPages";
import "./style.css";
import "./workspace.css";

const BACKEND_URL = import.meta.env.VITE_BACKEND_API_URL || "http://localhost:8080";
const AI_URL = import.meta.env.VITE_AI_API_URL || "http://127.0.0.1:5001";
const NOTIFICATION_URL =
  import.meta.env.VITE_NOTIFICATION_API_URL || "http://127.0.0.1:3001";

const NAV_ITEMS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "live", label: "Live Monitoring", icon: Camera },
  { id: "ai", label: "AI Analysis Studio", icon: BrainCircuit },
  { id: "incidents", label: "Incident Center", icon: MapPinned },
  { id: "dsa", label: "DSA Monitoring", icon: Waypoints },
  { id: "analytics", label: "Analytics & Insights", icon: BarChart3 },
  { id: "history", label: "History & Reports", icon: Clock3 },
  { id: "settings", label: "Settings", icon: Settings },
];

const PAGE_META = {
  overview: ["Overview", "Evidence-led incident monitoring at a glance."],
  live: ["Live Monitoring", "Connected sources and current processing state."],
  ai: ["AI Accident Analysis Studio", "Video-based vehicle tracking and heuristic event review."],
  incidents: ["Incident Center", "Backend incident locations and historical records."],
  dsa: ["DSA Monitoring", "Live C++ event queues, processing, and history."],
  analytics: ["Analytics & Insights", "Descriptive statistics computed from backend records."],
  history: ["History & Reports", "Searchable records returned by the C++ backend."],
  settings: ["Settings", "Service endpoints and available integrations."],
};

const EMPTY_DSA_STATUS = {
  queueSize: 0,
  pendingEvents: 0,
  severeStackSize: 0,
  severeAccidentCount: 0,
  processedEvents: 0,
  totalProcessedEvents: 0,
  totalEnqueuedEvents: 0,
  totalReceivedEvents: 0,
  processingStatus: "unknown",
  queueEvents: [],
  stackEvents: [],
  priorityEvents: [],
  historyEvents: [],
};

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(5000),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`The service returned an invalid response (${response.status}).`);
  }
  if (!response.ok || result?.success === false) {
    throw new Error(
      result?.error || result?.detail || result?.message || `Request failed (${response.status}).`
    );
  }
  return result;
}

function ConnectionBadge({ label, status }) {
  const className =
    status === "online" ? "online" : status === "checking" ? "checking" : "offline";
  const text =
    status === "online" ? "Online" : status === "checking" ? "Checking" : "Offline";
  return (
    <span className={`connection-badge ${className}`} aria-label={`${label}: ${text}`}>
      <i aria-hidden="true" />
      <span>{label}</span>
      <strong>{text}</strong>
    </span>
  );
}

function App() {
  const [activePage, setActivePage] = useState("overview");
  const [dsaStatus, setDsaStatus] = useState(EMPTY_DSA_STATUS);
  const [dsaLoading, setDsaLoading] = useState(true);
  const [dsaError, setDsaError] = useState("");
  const [backendStatus, setBackendStatus] = useState("checking");
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [vehicles, setVehicles] = useState([]);
  const [vehicleStatus, setVehicleStatus] = useState("checking");
  const [aiStatus, setAiStatus] = useState({ connection: "checking" });
  const [notificationStatus, setNotificationStatus] = useState("checking");
  const [processing, setProcessing] = useState(false);
  const [processFeedback, setProcessFeedback] = useState(null);
  const processLock = useRef(false);

  const fetchDsaStatus = useCallback(async () => {
    setDsaLoading(true);
    setDsaError("");
    try {
      const result = await fetchJson(`${BACKEND_URL}/api/dsa/status`);
      if (
        !Array.isArray(result.queueEvents) ||
        !Array.isArray(result.stackEvents) ||
        !Array.isArray(result.priorityEvents) ||
        !Array.isArray(result.historyEvents)
      ) {
        throw new Error(
          "The C++ backend returned an incomplete DSA status response. Run the current backend build."
        );
      }
      setDsaStatus({
        ...EMPTY_DSA_STATUS,
        ...result,
      });
      setBackendStatus("online");
    } catch (error) {
      console.warn("C++ DSA status unavailable:", error.message);
      setDsaError(error.message || "Could not load C++ backend status.");
      setBackendStatus("offline");
    } finally {
      setDsaLoading(false);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const result = await fetchJson(`${BACKEND_URL}/api/accidents/history`);
      setHistory(Array.isArray(result.accidents) ? result.accidents : []);
    } catch (error) {
      console.warn("Accident history unavailable:", error.message);
      setHistoryError(error.message || "Could not load accident history.");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const fetchVehicles = useCallback(async () => {
    setVehicleStatus("checking");
    try {
      const result = await fetchJson(`${BACKEND_URL}/api/vehicles`);
      setVehicles(Array.isArray(result.vehicles) ? result.vehicles : []);
      setVehicleStatus("online");
    } catch (error) {
      console.warn("Registered vehicle endpoint unavailable:", error.message);
      setVehicleStatus("offline");
    }
  }, []);

  const fetchAiStatus = useCallback(async () => {
    try {
      const result = await fetchJson(`${AI_URL}/api/ai/status`);
      setAiStatus({ ...result, connection: "online" });
    } catch (error) {
      setAiStatus({ connection: "offline", error: error.message });
    }
  }, []);

  const fetchNotificationStatus = useCallback(async () => {
    try {
      await fetchJson(`${NOTIFICATION_URL}/api/health`);
      setNotificationStatus("online");
    } catch {
      setNotificationStatus("offline");
    }
  }, []);

  const refreshAll = useCallback(() => {
    void Promise.all([
      fetchDsaStatus(),
      fetchHistory(),
      fetchAiStatus(),
      fetchNotificationStatus(),
    ]);
  }, [
    fetchAiStatus,
    fetchDsaStatus,
    fetchHistory,
    fetchNotificationStatus,
  ]);

  useEffect(() => {
    refreshAll();
    const timer = window.setInterval(refreshAll, 15000);
    return () => window.clearInterval(timer);
  }, [refreshAll]);

  useEffect(() => {
    if (activePage === "live" || activePage === "analytics") {
      void fetchVehicles();
    }
  }, [activePage, fetchVehicles]);

  async function processNextAccident(priority = false) {
    if (processLock.current) return;
    const pending = Number(dsaStatus.pendingEvents ?? dsaStatus.queueSize ?? 0);
    const candidates = priority ? dsaStatus.priorityEvents : dsaStatus.queueEvents;
    const nextEvent = candidates[0];
    if (pending === 0 || !nextEvent) {
      setProcessFeedback({ type: "info", text: "No pending events to process." });
      return;
    }

    processLock.current = true;
    setProcessing(true);
    setProcessFeedback(null);
    try {
      const endpoint = priority ? "process-priority" : "process";
      const result = await fetchJson(`${BACKEND_URL}/api/dsa/${endpoint}`, {
        method: "POST",
      });
      if (result.processedEventId === undefined || result.processedEventId === null) {
        setProcessFeedback({
          type: "info",
          text: result.message || "The backend did not process an event.",
        });
      } else {
        setProcessFeedback({
          type: "success",
          text: `Event #${nextEvent.eventId || result.processedEventId} processed successfully.`,
        });
      }
      await Promise.all([fetchDsaStatus(), fetchHistory()]);
    } catch (error) {
      console.error("DSA processing request failed:", error);
      setProcessFeedback({
        type: "error",
        text: error.message || "Could not process the event. Backend data was not changed in the dashboard.",
      });
    } finally {
      processLock.current = false;
      setProcessing(false);
    }
  }

  const [title, subtitle] = PAGE_META[activePage];
  const sharedPageProps = {
    history,
    historyLoading,
    historyError,
    dsaStatus,
    dsaLoading,
    dsaError,
    backendStatus,
    aiStatus,
    vehicles,
    vehicleStatus,
    onNavigate: setActivePage,
    onRefresh: refreshAll,
  };

  return (
    <div className="monitoring-app">
      <aside className="app-sidebar">
        <div className="app-brand">
          <div className="app-brand-mark"><ShieldCheck size={23} /></div>
          <div>
            <strong>SafeDrive</strong>
            <span>INCIDENT MONITORING</span>
          </div>
        </div>

        <p className="sidebar-caption">WORKSPACE</p>
        <nav className="primary-nav" aria-label="Primary navigation">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`primary-nav-item ${activePage === id ? "active" : ""}`}
              onClick={() => setActivePage(id)}
              aria-current={activePage === id ? "page" : undefined}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-system">
          <ConnectionBadge label="C++ backend" status={backendStatus} />
          <ConnectionBadge label="AI service" status={aiStatus.connection} />
          <p>Academic monitoring prototype. No emergency dispatch is performed.</p>
        </div>
      </aside>

      <main className="app-main">
        <header className="app-header">
          <div>
            <p className="breadcrumb">SAFEDRIVE <span>/</span> {title.toUpperCase()}</p>
            <h1>{title}</h1>
            <p className="page-subtitle">{subtitle}</p>
          </div>
          <div className="header-actions">
            <ConnectionBadge label="C++" status={backendStatus} />
            <ConnectionBadge label="AI" status={aiStatus.connection} />
            <button className="icon-action" type="button" onClick={refreshAll} aria-label="Refresh backend data">
              <RefreshCw size={17} />
              <span>Refresh</span>
            </button>
          </div>
        </header>

        <div className="page-content">
          {activePage === "overview" && <OverviewPage {...sharedPageProps} />}
          {activePage === "live" && <LiveMonitoringPage {...sharedPageProps} onRefreshVehicles={fetchVehicles} />}
          {activePage === "ai" && <AIDetection />}
          {activePage === "incidents" && <IncidentCenterPage {...sharedPageProps} />}
          {activePage === "dsa" && (
            <DSAMonitoring
              status={dsaStatus}
              loading={dsaLoading}
              error={dsaError}
              processing={processing}
              processFeedback={processFeedback}
              onRefresh={refreshAll}
              onProcessFifo={() => processNextAccident(false)}
              onProcessPriority={() => processNextAccident(true)}
            />
          )}
          {activePage === "analytics" && <AnalyticsPage {...sharedPageProps} onRefreshVehicles={fetchVehicles} />}
          {activePage === "history" && <HistoryPage {...sharedPageProps} />}
          {activePage === "settings" && (
            <SettingsPage
              {...sharedPageProps}
              notificationStatus={notificationStatus}
              backendUrl={BACKEND_URL}
              aiUrl={AI_URL}
              notificationUrl={NOTIFICATION_URL}
            />
          )}
        </div>

        <footer className="app-footer">
          <span>SafeDrive · Smart Accident Detection System</span>
          <span>AI indicators are not independently verified accident confirmations.</span>
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
