const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildSimulationMessage,
  isSmsTestMode,
  validateSimulationAlert,
} = require("../simulation-alert");

const severeAlert = {
  incidentId: "simulation-test-1",
  accidentId: 7,
  latitude: 24.918,
  longitude: 67.097,
  timestamp: "2026-11-15T12:00:00.000Z",
  impactScore: 100,
  severity: "Severe",
  hospital: {
    name: "Listed Hospital",
    distance: 1.25,
    lat: 24.92,
    lon: 67.1,
  },
};

test("safe SMS test mode is the default and requires explicit opt-out", () => {
  assert.equal(isSmsTestMode(undefined), true);
  assert.equal(isSmsTestMode("true"), true);
  assert.equal(isSmsTestMode("false"), false);
});

test("emergency demo alerts require a backend-classified severe incident", () => {
  assert.equal(validateSimulationAlert(severeAlert), null);
  assert.match(
    validateSimulationAlert({ ...severeAlert, severity: "Moderate" }),
    /Severe classification/
  );
  assert.match(
    validateSimulationAlert({ ...severeAlert, impactScore: 101 }),
    /score/
  );
});

test("demo message contains backend accident details and map links", () => {
  const message = buildSimulationMessage(severeAlert);
  assert.match(message, /Accident ID: 7/);
  assert.match(message, /Severity: Severe/);
  assert.match(message, /Impact Score: 100/);
  assert.match(message, /https:\/\/www\.google\.com\/maps\?q=24\.918,67\.097/);
  assert.match(message, /DEMO ONLY/);
});
