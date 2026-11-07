import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const { default: DSAMonitoring } = await server.ssrLoadModule(
    "/src/components/DSAMonitoring.jsx"
  );
  const aiEvent = {
    id: 21,
    eventId: "run-AI-00001",
    impactScore: 0,
    severity: "Suspected Accident",
    timestamp: "00:00:01.250",
    eventType: "suspected_accident",
    confidence: "medium",
    vehicleIds: [12, 34],
    evidence: [{ type: "sudden_deceleration", label: "Sudden decrease in speed" }],
    hasLocation: true,
    latitude: 24.86,
    longitude: 67.0,
    status: "Pending",
  };
  const severeEvent = {
    ...aiEvent,
    id: 20,
    eventId: "",
    timestamp: "2026-11-07 10:00:00",
    eventType: "head-on",
    severity: "Severe",
    impactScore: 95,
    hasLocation: false,
    status: "Processed",
  };
  const status = {
    totalReceivedEvents: 2,
    totalEnqueuedEvents: 2,
    pendingEvents: 1,
    queueSize: 1,
    severeAccidentCount: 1,
    severeStackSize: 1,
    totalProcessedEvents: 1,
    processedEvents: 1,
    processingStatus: "pending",
    queueEvents: [aiEvent],
    stackEvents: [severeEvent],
    priorityEvents: [severeEvent, aiEvent],
    historyEvents: [severeEvent, aiEvent],
  };
  const markup = renderToStaticMarkup(
    React.createElement(DSAMonitoring, {
      status,
      loading: false,
      error: "",
      processing: false,
      processFeedback: {
        type: "success",
        text: "Event run-AI-00001 processed successfully.",
      },
      onRefresh() {},
      onProcessFifo() {},
      onProcessPriority() {},
    })
  );

  for (const text of [
    "FIFO Queue",
    "LIFO Stack",
    "Priority Queue",
    "Vector / History",
    "RECEIVED: 2",
    "Process Oldest (FIFO)",
    "Process Highest Priority",
    "run-AI-00001",
    "00:00:01.250",
    "12, 34",
    "Sudden decrease in speed",
    "24.86, 67",
    "Location unavailable",
    "2026-11-07 10:00:00",
    "Event run-AI-00001 processed successfully.",
  ]) {
    assert.ok(markup.includes(text), `Expected rendered DSA data to include "${text}"`);
  }
  assert.ok(!markup.includes("<dialog"), "DSA processing must not render a dialog");
  assert.ok(!markup.toLowerCase().includes("qt box"), "DSA page must not render a QT box");

  const loadingMarkup = renderToStaticMarkup(
    React.createElement(DSAMonitoring, {
      status,
      loading: true,
      error: "",
      processing: false,
      processFeedback: null,
      onRefresh() {},
      onProcessFifo() {},
      onProcessPriority() {},
    })
  );
  assert.ok(loadingMarkup.includes("Loading live DSA data..."));

  const errorMarkup = renderToStaticMarkup(
    React.createElement(DSAMonitoring, {
      status,
      loading: false,
      error: "Backend unavailable",
      processing: false,
      processFeedback: null,
      onRefresh() {},
      onProcessFifo() {},
      onProcessPriority() {},
    })
  );
  assert.ok(errorMarkup.includes("Backend unavailable"));

  const emptyMarkup = renderToStaticMarkup(
    React.createElement(DSAMonitoring, {
      status: {
        ...status,
        pendingEvents: 0,
        queueSize: 0,
        queueEvents: [],
        priorityEvents: [],
        stackEvents: [],
        historyEvents: [],
      },
      loading: false,
      error: "",
      processing: false,
      processFeedback: null,
      onRefresh() {},
      onProcessFifo() {},
      onProcessPriority() {},
    })
  );
  assert.ok(emptyMarkup.includes("No pending events"));
} finally {
  await server.close();
}

console.log("DSA rendering test passed.");
