import React from "react";
import { AlertCircle, CheckCircle2, Clock, RotateCcw, Zap } from "lucide-react";

export default function DSAMonitoring({
  status,
  loading,
  error,
  processing = false,
  processFeedback = null,
  onRefresh,
  onProcessFifo,
  onProcessPriority,
}) {
  const queueEvents = Array.isArray(status.queueEvents) ? status.queueEvents : [];
  const stackEvents = Array.isArray(status.stackEvents) ? status.stackEvents : [];
  const priorityEvents = Array.isArray(status.priorityEvents) ? status.priorityEvents : [];
  const historyEvents = Array.isArray(status.historyEvents) ? status.historyEvents : [];
  const pendingCount = Number(status.pendingEvents ?? status.queueSize ?? 0);

  return (
    <section className="workspace-panel dsa-monitor-panel">
      <div className="workspace-panel-heading">
        <div>
          <span className="section-label">DATA STRUCTURES</span>
          <h2>DSA Event Processing</h2>
          <p>Live C++ event structures. Video-only AI events are indicators, not confirmed crashes.</p>
        </div>
        <div className="panel-actions">
          <span className="received-count">RECEIVED: {status.totalReceivedEvents ?? status.totalEnqueuedEvents ?? "—"}</span>
          <button type="button" className="icon-action compact" onClick={onRefresh} disabled={loading || processing}>
            <RotateCcw size={15} /><span>Refresh</span>
          </button>
        </div>
      </div>

      {error && <div className="inline-message error" role="alert"><AlertCircle size={17} />{error}</div>}
      {loading ? (
        <div className="workspace-state" role="status"><Clock size={20} /><span>Loading live DSA data...</span></div>
      ) : error ? null : (
        <>
          <div className="metric-grid compact-grid">
            <article className="metric-card violet"><span>Pending events</span><strong>{pendingCount}</strong><small>FIFO queue</small></article>
            <article className="metric-card red"><span>Severe events</span><strong>{status.severeAccidentCount ?? status.severeStackSize ?? 0}</strong><small>LIFO stack</small></article>
            <article className="metric-card blue"><span>Processed events</span><strong>{status.totalProcessedEvents ?? status.processedEvents ?? 0}</strong><small>Backend count</small></article>
            <article className="metric-card green"><span>Processing status</span><strong>{status.processingStatus || "Unavailable"}</strong><small>C++ backend</small></article>
          </div>

          <div className="dsa-process-actions">
            <button type="button" className="primary-action" onClick={onProcessFifo} disabled={loading || processing || pendingCount === 0 || queueEvents.length === 0}>
              <Zap size={16} />
              {processing ? "Processing…" : pendingCount === 0 ? "No pending events" : "Process Oldest (FIFO)"}
            </button>
            <button type="button" className="quiet-button" onClick={onProcessPriority} disabled={loading || processing || priorityEvents.length === 0}>
              <Zap size={16} />
              {processing ? "Processing…" : "Process Highest Priority"}
            </button>
          </div>

          {processFeedback && (
            <p className={`dsa-process-feedback ${processFeedback.type}`} role={processFeedback.type === "error" ? "alert" : "status"}>
              {processFeedback.type === "success" ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
              {processFeedback.text}
            </p>
          )}

          <div className="dsa-structures-grid">
            <StructurePanel title="FIFO Queue" purpose="First In, First Out · oldest pending event is processed first" count={queueEvents.length}>
              {queueEvents.length === 0 ? <EmptyStructure>Queue is empty</EmptyStructure> : (
                <div className="dsa-event-list">
                  {queueEvents.map((event, index) => (
                    <EventCard key={`queue-${event.id}`} event={event} marker={index === 0 ? "FRONT · NEXT" : "PENDING"} />
                  ))}
                </div>
              )}
            </StructurePanel>

            <StructurePanel title="LIFO Stack" purpose="Last In, First Out · newest severe event is on top" count={stackEvents.length}>
              {stackEvents.length === 0 ? <EmptyStructure>Stack is empty</EmptyStructure> : (
                <div className="dsa-event-list">
                  {stackEvents.map((event, index) => (
                    <EventCard key={`stack-${event.id}`} event={event} marker={index === 0 ? "TOP · NEWEST" : "BELOW"} />
                  ))}
                </div>
              )}
            </StructurePanel>

            <StructurePanel title="Priority Queue" purpose="Backend severity rank and impact ordering; preserve C++ tie-break rules" count={priorityEvents.length}>
              {priorityEvents.length === 0 ? <EmptyStructure>Priority queue is empty</EmptyStructure> : (
                <div className="dsa-event-list">
                  {priorityEvents.map((event, index) => (
                    <EventCard key={`priority-${event.id}`} event={event} marker={index === 0 ? "NEXT · HIGHEST" : `PRIORITY ${index + 1}`} />
                  ))}
                </div>
              )}
            </StructurePanel>

            <StructurePanel title="Vector / History" purpose="Backend arrival order · in-memory history limit applies" count={historyEvents.length}>
              {historyEvents.length === 0 ? <EmptyStructure>History is empty</EmptyStructure> : (
                <div className="dsa-event-list">
                  {historyEvents.map((event) => (
                    <EventCard key={`history-${event.id}`} event={event} marker={event.status || "RECORDED"} showMetadata />
                  ))}
                </div>
              )}
            </StructurePanel>
          </div>
        </>
      )}
    </section>
  );
}

function StructurePanel({ title, purpose, count, children }) {
  return (
    <section className="dsa-box">
      <div className="dsa-box-heading">
        <div><h3>{title}</h3><p>{purpose}</p></div>
        <span className="received-count">{count}</span>
      </div>
      {children}
    </section>
  );
}

function EmptyStructure({ children }) {
  return <div className="workspace-state compact-state"><span>{children}</span></div>;
}

function EventCard({ event, marker, showMetadata = false }) {
  const id = event.eventId || (event.id !== undefined ? `#${event.id}` : "ID unavailable");
  const impact = event.impactScore;
  return (
    <article className="dsa-event-card">
      <div className="dsa-event-header"><strong>Event {id}</strong><span>{marker}</span></div>
      <p>{event.eventType || "Backend event"} · {event.severity || "Severity unavailable"}</p>
      <p>Impact score: {impact === null || impact === undefined ? "Not provided" : `${impact}/100`}</p>
      <small>{event.timestamp || "Timestamp unavailable"}</small>
      {showMetadata && (
        <>
          <p>Vehicle IDs: {Array.isArray(event.vehicleIds) && event.vehicleIds.length ? event.vehicleIds.join(", ") : "Not available"}</p>
          <p>Confidence: {event.confidence ?? "Not provided"}</p>
          {Array.isArray(event.evidence) && event.evidence.length > 0 && (
            <p>Evidence: {event.evidence.map((item) => item.label || item.type).join(", ")}</p>
          )}
          {event.hasLocation && event.latitude !== null && event.longitude !== null
            ? <p>GPS: {event.latitude}, {event.longitude}</p>
            : <p>Location unavailable</p>}
        </>
      )}
    </article>
  );
}
