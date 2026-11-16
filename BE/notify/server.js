
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const twilio = require("twilio");
const { Resend } = require("resend");
const rateLimit = require("express-rate-limit");
const { createIdempotentAction } = require("./simulation-idempotency");
const {
  buildSimulationMessage,
  isSmsTestMode,
  validateSimulationAlert,
} = require("./simulation-alert");

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
const smsTestMode = isSmsTestMode(process.env.SMS_TEST_MODE);

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "notification-service",
    smsConfigured: Boolean(smsClient),
    demoContactsConfigured: demoNumbers.length,
    smsTestMode,
  });
});

// DEMO ACCIDENT SMS
app.post("/api/simulation-accident", async (req, res) => {
  const payload = req.body || {};
  const validationError = validateSimulationAlert(payload);
  if (validationError) {
    return res.status(400).json({
      success: false,
      error: validationError,
    });
  }
  const { incidentId } = payload;

  if (smsTestMode) {
    const outcome = await sendSimulationOnce(incidentId, async () => ({
      statusCode: 200,
      body: {
        success: true,
        status: "test_mode",
        sent: false,
        sentCount: 0,
        totalContacts: demoNumbers.length,
        message:
          "SAFE TEST MODE: the severe-incident SMS was validated, but no message was sent.",
      },
    }));
    return res
      .status(outcome.result.statusCode)
      .json({ ...outcome.result.body, duplicate: outcome.duplicate });
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

  const message = buildSimulationMessage(payload);

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

const port = Number(process.env.NOTIFICATION_PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("NOTIFICATION_PORT must be an integer between 1 and 65535.");
}

app.listen(port, "127.0.0.1", () => {
  console.log(`Notification service running at http://127.0.0.1:${port}`);
});
