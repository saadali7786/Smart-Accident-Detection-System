function validateSimulationAlert(payload = {}) {
  const {
    incidentId,
    accidentId,
    latitude,
    longitude,
    impactScore,
    severity,
  } = payload;

  if (
    typeof incidentId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,160}$/.test(incidentId) ||
    !Number.isSafeInteger(accidentId) ||
    accidentId < 1 ||
    !Number.isInteger(impactScore) ||
    impactScore < 0 ||
    impactScore > 100 ||
    severity !== "Severe" ||
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return "A unique incident ID, accident ID, score, coordinates, and Severe classification are required.";
  }

  return null;
}

function isSmsTestMode(value) {
  return value !== "false";
}

function buildSimulationMessage({
  incidentId,
  accidentId,
  latitude,
  longitude,
  timestamp,
  impactScore,
  severity,
  hospital,
}) {
  const hospitalName =
    typeof hospital?.name === "string" && hospital.name.trim()
      ? hospital.name.trim().slice(0, 150)
      : "Hospital information unavailable";
  const hospitalDistance =
    Number.isFinite(hospital?.distance) && hospital.distance >= 0
      ? `${hospital.distance.toFixed(2)} km`
      : "Unknown";
  const hospitalMapsUrl =
    Number.isFinite(hospital?.lat) &&
    Number.isFinite(hospital?.lon) &&
    Math.abs(hospital.lat) <= 90 &&
    Math.abs(hospital.lon) <= 180
      ? `https://www.google.com/maps?q=${hospital.lat},${hospital.lon}`
      : "Not available";
  const accidentTime =
    typeof timestamp === "string" && timestamp.length <= 60
      ? timestamp
      : new Date().toISOString();
  const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;

  return [
    "🚨 SIMULATED ACCIDENT ALERT - DEMO ONLY",
    `Incident ID: ${incidentId}`,
    `Accident ID: ${accidentId}`,
    `Severity: ${severity}`,
    `Impact Score: ${impactScore}`,
    "",
    `Latitude: ${latitude}`,
    `Longitude: ${longitude}`,
    `Time: ${accidentTime}`,
    "",
    `Nearest hospital: ${hospitalName}`,
    `Hospital distance: ${hospitalDistance}`,
    `Hospital map: ${hospitalMapsUrl}`,
    "",
    `Accident location: ${mapsUrl}`,
    "",
    "This is a software simulation, NOT a real emergency report.",
    "No emergency service has been contacted.",
  ].join("\n");
}

module.exports = {
  buildSimulationMessage,
  isSmsTestMode,
  validateSimulationAlert,
};
