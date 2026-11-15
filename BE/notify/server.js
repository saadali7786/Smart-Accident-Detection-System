
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const twilio = require("twilio");
const { Resend } = require("resend");
const rateLimit = require("express-rate-limit");
const { createIdempotentAction } = require("./simulation-idempotency");

const app = express();
const sendSimulationOnce = createIdempotentAction();

app.use(
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  })
);
app.use(express.json({ limit: "20kb" }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skip: (req) => req.path === "/api/health",
  })
);

const validPhone = (value) => /^\+[1-9]\d{7,14}$/.test(value || "");

const validTwilioSid = /^AC[a-fA-F0-9]{32}$/.test(
  process.env.TWILIO_ACCOUNT_SID || ""
);

const smsClient =
  validTwilioSid && process.env.TWILIO_AUTH_TOKEN
    ? twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      )
    : null;

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const demoNumbers = [
  process.env.DEMO_CONTACT_PHONE_1,
  process.env.DEMO_CONTACT_PHONE_2,
].filter(validPhone);

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "notification-service",
    smsConfigured: Boolean(smsClient),
    demoContactsConfigured: demoNumbers.length,
  });
});

// DEMO ACCIDENT SMS
app.post("/api/simulation-accident", async (req, res) => {
  const { incidentId, latitude, longitude, timestamp, hospital } =
    req.body || {};

  if (
    typeof incidentId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,160}$/.test(incidentId) ||
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return res.status(400).json({
      success: false,
      error: "A valid incident ID and accident latitude and longitude are required.",
    });
  }

  if (!smsClient) {
    return res.status(503).json({
      success: false,
      error: "Twilio is not configured. Check notification .env.",
    });
  }

  if (!validPhone(process.env.TWILIO_PHONE_NUMBER)) {
    return res.status(503).json({
      success: false,
      error: "Invalid Twilio sender phone number.",
    });
  }

  if (demoNumbers.length !== 2) {
    return res.status(503).json({
      success: false,
      error: "Both demo contact numbers must be configured correctly.",
    });
  }

  const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;

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

  const message = [
    "🚨 SIMULATED ACCIDENT ALERT - DEMO ONLY",
    `Incident ID: ${incidentId}`,
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

  try {
    const outcome = await sendSimulationOnce(incidentId, async () => {
      const results = await Promise.allSettled(
        demoNumbers.map((phone) =>
          smsClient.messages.create({
            from: process.env.TWILIO_PHONE_NUMBER,
            to: phone,
            body: message,
          })
        )
      );

      const notifications = results.map((result, index) => ({
        contact: index + 1,
        status: result.status === "fulfilled" ? "sent" : "failed",
      }));

      results.forEach((result, index) => {
        if (result.status === "rejected") {
          console.error(
            `Demo SMS ${index + 1} failed:`,
            result.reason?.message || "Unknown provider error"
          );
        }
      });

      const sentCount = notifications.filter(
        (item) => item.status === "sent"
      ).length;

      return {
        statusCode: sentCount > 0 ? 200 : 502,
        body: {
          success: sentCount > 0,
          notifications,
          sentCount,
          totalContacts: demoNumbers.length,
          message:
            sentCount === 2
              ? "Both demo SMS notifications were accepted by Twilio."
              : sentCount === 1
                ? "One demo SMS was accepted; one failed."
                : "Both demo SMS notifications failed.",
          note: "Twilio acceptance does not guarantee delivery. DEMO ONLY.",
        },
      };
    });

    return res
      .status(outcome.result.statusCode)
      .json({ ...outcome.result.body, duplicate: outcome.duplicate });
  } catch (notificationError) {
    console.error(
      "Simulation SMS operation failed:",
      notificationError.message || "Unknown provider error"
    );
    return res.status(502).json({
      success: false,
      error: "The DEMO SMS operation failed and will not be retried automatically.",
    });
  }
});

// Existing manual report endpoint
app.post("/api/report", async (req, res) => {
  const {
    reporterName,
    location,
    severity,
    description,
    confirmed,
  } = req.body || {};

  if (
    confirmed !== true ||
    typeof reporterName !== "string" ||
    typeof location !== "string" ||
    typeof description !== "string" ||
    !reporterName.trim() ||
    !location.trim() ||
    !description.trim() ||
    reporterName.length > 100 ||
    location.length > 300 ||
    description.length > 2000 ||
    !["Minor", "Moderate", "Severe", "Critical"].includes(severity)
  ) {
    return res.status(400).json({
      success: false,
      error: "Please provide valid report details and confirm.",
    });
  }

  const message = [
    "MANUALLY SUBMITTED ACCIDENT REPORT",
    `Severity: ${severity}`,
    `Reported by: ${reporterName.trim()}`,
    `Location: ${location.trim()}`,
    `Details: ${description.trim()}`,
    `Time: ${new Date().toISOString()}`,
    "This report has not been independently verified.",
  ].join("\n");

  const results = await Promise.allSettled([
    smsClient
      ? smsClient.messages.create({
          from: process.env.TWILIO_PHONE_NUMBER,
          to: process.env.EMERGENCY_CONTACT_PHONE,
          body: message,
        })
      : Promise.reject(new Error("Twilio is not configured")),

    resend
      ? resend.emails.send({
          from: process.env.EMAIL_FROM,
          to: [process.env.EMERGENCY_CONTACT_EMAIL],
          subject: `Accident report: ${severity}`,
          text: message,
        })
      : Promise.reject(new Error("Resend is not configured")),
  ]);

  const smsSent = results[0].status === "fulfilled";
  const emailSent = results[1].status === "fulfilled";

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(
        index === 0 ? "SMS failed:" : "Email failed:",
        result.reason?.message || "Unknown provider error"
      );
    }
  });

  res.status(smsSent || emailSent ? 200 : 502).json({
    success: smsSent || emailSent,
    notifications: {
      sms: smsSent ? "sent" : "failed",
      email: emailSent ? "sent" : "failed",
    },
    message: smsSent && emailSent
      ? "Both providers accepted the notifications."
      : smsSent
        ? "SMS accepted; email failed."
        : emailSent
          ? "Email accepted; SMS failed."
          : "Both notifications failed.",
    note: "Provider acceptance does not guarantee delivery.",
  });
});

app.listen(3001, "127.0.0.1", () => {
  console.log("Notification service running at http://localhost:3001");
});
