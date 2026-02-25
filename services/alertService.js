'use strict';

const Alert = require('../models/Alert');

// ─── In-memory deduplication ──────────────────────────────────────────────────
// Tracks which sensor:severity combinations already have an active alert.
// Avoids a DB round-trip on every telemetry packet for the common (no-alert) case.
// Populated lazily from DB so it survives restarts.
const activeKeys = new Set(); // `${sensor}:${severity}`

// ─── Threshold definitions ────────────────────────────────────────────────────
// Each entry: { sensor, severity, label, threshold, check(payload) → bool }
// check() returns true when the alert SHOULD fire.
const THRESHOLD_RULES = [
  {
    sensor: 'ph', severity: 'warning',
    label: 'pH Sensor', threshold: '6.5 – 8.5',
    check: p => p.ph < 6.5 || p.ph > 8.5,
    message: p => `pH at ${p.ph.toFixed(2)} is outside safe range (6.5 – 8.5)`,
  },
  {
    sensor: 'tds', severity: 'warning',
    label: 'TDS Sensor', threshold: '≤ 5000 ppm',
    check: p => p.tds > 5000,
    message: p => `TDS at ${p.tds.toFixed(0)} ppm exceeds EOR limit of 5000 ppm`,
  },
  {
    sensor: 'temperature', severity: 'warning',
    label: 'Temperature Sensor', threshold: '10 – 40 °C',
    check: p => p.temperature < 10 || p.temperature > 40,
    message: p => `Temperature at ${p.temperature.toFixed(1)} °C is outside safe range (10 – 40 °C)`,
  },
  {
    sensor: 'flow_rate', severity: 'warning',
    label: 'Flow Rate Sensor', threshold: '0.5 – 10 L/min',
    check: p => p.flow_rate < 0.5 || p.flow_rate > 10,
    message: p => `Flow rate at ${p.flow_rate.toFixed(2)} L/min is outside safe range (0.5 – 10 L/min)`,
  },
];

const OFFLINE_THRESHOLD_MS = 60_000; // 60 s without telemetry → device offline alert

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Creates and persists a new alert, then emits it via Socket.io.
 * No-ops if an active alert for the same sensor + severity already exists.
 */
async function createAlert(io, { severity, sensor, message, value, threshold }) {
  const key = `${sensor}:${severity}`;
  if (activeKeys.has(key)) return;

  // Sync in-memory set with DB on first encounter (handles server restarts)
  const existing = await Alert.findOne({ sensor, severity, status: 'active' });
  if (existing) {
    activeKeys.add(key);
    return;
  }

  activeKeys.add(key);

  const doc = await Alert.create({ severity, sensor, message, value, threshold });
  io.emit('system_alert', formatAlert(doc.toObject()));

  console.log(`[alertService] 🚨 [${severity.toUpperCase()}] ${sensor} — ${message}`);
}

/**
 * Resolves all active/acknowledged alerts for a given sensor.
 * Called when a condition clears (reading back in safe range).
 */
async function resolveAlertsForSensor(io, sensor) {
  // Remove all severity levels for this sensor from the in-memory set
  for (const key of activeKeys) {
    if (key.startsWith(`${sensor}:`)) activeKeys.delete(key);
  }

  const result = await Alert.updateMany(
    { sensor, status: { $in: ['active', 'acknowledged'] } },
    { status: 'resolved', resolvedAt: new Date() }
  );

  if (result.modifiedCount > 0) {
    console.log(`[alertService] ✅ Auto-resolved ${result.modifiedCount} alert(s) for: ${sensor}`);
    io.emit('alert_resolved', { sensor });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Called after every valid telemetry packet.
 * Evaluates all threshold rules and fires/clears alerts as needed.
 */
async function processTelemetryAlerts(io, payload) {
  try {
    for (const rule of THRESHOLD_RULES) {
      if (rule.check(payload)) {
        await createAlert(io, {
          severity:  rule.severity,
          sensor:    rule.sensor,
          message:   rule.message(payload),
          value:     payload[rule.sensor],
          threshold: rule.threshold,
        });
      } else {
        await resolveAlertsForSensor(io, rule.sensor);
      }
    }
  } catch (err) {
    console.error('[alertService] processTelemetryAlerts error:', err.message);
  }
}

/**
 * Called periodically by server.js.
 * Fires a critical alert if no telemetry has been received for OFFLINE_THRESHOLD_MS.
 */
async function checkDeviceOffline(io, SystemLog) {
  try {
    const latest = await SystemLog.findOne().sort({ timestamp: -1 }).lean();
    if (!latest) return; // no data ever received — don't alert yet

    const ageMs = Date.now() - new Date(latest.timestamp).getTime();

    if (ageMs > OFFLINE_THRESHOLD_MS) {
      await createAlert(io, {
        severity:  'critical',
        sensor:    'device',
        message:   `No telemetry received for ${Math.floor(ageMs / 1000)} s — device may be offline`,
        threshold: `< ${OFFLINE_THRESHOLD_MS / 1000} s since last packet`,
      });
    } else {
      await resolveAlertsForSensor(io, 'device');
    }
  } catch (err) {
    console.error('[alertService] checkDeviceOffline error:', err.message);
  }
}

// ─── Formatter (shared with routes) ──────────────────────────────────────────

function formatAlert(doc) {
  return {
    id:         doc._id.toString(),
    severity:   doc.severity,
    sensor:     doc.sensor,
    message:    doc.message,
    value:      doc.value,
    threshold:  doc.threshold,
    timestamp:  doc.timestamp instanceof Date ? doc.timestamp.toISOString() : doc.timestamp,
    status:     doc.status,
    resolvedAt: doc.resolvedAt ? (doc.resolvedAt instanceof Date ? doc.resolvedAt.toISOString() : doc.resolvedAt) : undefined,
  };
}

module.exports = { processTelemetryAlerts, checkDeviceOffline, formatAlert };
