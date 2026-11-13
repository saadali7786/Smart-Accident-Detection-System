
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const twilio = require("twilio");
const { Resend } = require("resend");
const rateLimit = require("express-rate-limit");

const app = express();

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json({ limit: "20kb" }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skip: (req) => req.path === "/api/health",
}));

const required = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "EMERGENCY_CONTACT_PHONE",
  "EMERGENCY_CONTACT_EMAIL",
];

const missing = required.filter((key) => !process.env[key]);

if (missing.length) {
  console.warn("Notification settings missing:", missing.join(", "));
}

const validTwilioSid = /^AC[a-fA-F0-9]{32}$/.test(
  process.env.TWILIO_ACCOUNT_SID || ""
);

const smsClient = validTwilioSid && process.env.TWILIO_AUTH_TOKEN
  ? twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    )
  : null;

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "notification-service",
  });
});

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
    note: "Provider acceptance does not guarantee delivery or emergency dispatch.",
  });
});

app.listen(3001, "127.0.0.1", () => {
  console.log("Notification service running at http://localhost:3001");
});
