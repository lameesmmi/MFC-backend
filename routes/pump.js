'use strict';

/**
 * Pump Command Route
 * ──────────────────
 * Exposes a single endpoint that translates HTTP requests into MQTT
 * commands for the ESP32, which interprets them to control the water pump.
 *
 * POST /api/pump/command  — operator / admin only
 */

const express = require('express');
const router  = express.Router();
const { requireRole } = require('../middleware/auth');

// ─── Constants ────────────────────────────────────────────────────────────────

const COMMAND_TOPIC   = 'mfc/system/_01/command';
const VALID_COMMANDS  = new Set(['MANUAL_ON', 'MANUAL_OFF', 'AUTO']);

// ─── Route ────────────────────────────────────────────────────────────────────

/**
 * POST /api/pump/command
 *
 * Publishes one of three string payloads to the ESP32 command topic:
 *   "MANUAL_ON"  — turns the pump on and locks out the automatic sensor loop
 *   "MANUAL_OFF" — turns the pump off and locks out the automatic sensor loop
 *   "AUTO"       — releases manual override; ESP32 resumes its automatic logic
 *
 * After a successful publish the new mode is broadcast to all connected
 * frontend clients via Socket.io so every open tab stays in sync.
 *
 * Body   : { command: 'MANUAL_ON' | 'MANUAL_OFF' | 'AUTO' }
 * Returns: { ok: true, command, topic }
 */
router.post('/command', requireRole('admin', 'operator'), async (req, res) => {
  const { command } = req.body;

  // ── Validate command ───────────────────────────────────────────────────────
  if (!command || !VALID_COMMANDS.has(command)) {
    return res.status(400).json({
      error: `Invalid command. Accepted values: ${[...VALID_COMMANDS].join(', ')}`,
    });
  }

  // ── Check MQTT connectivity ────────────────────────────────────────────────
  const mqttClient = req.app.get('mqttClient');
  if (!mqttClient?.connected) {
    return res.status(503).json({ error: 'MQTT broker is not connected' });
  }

  // ── Publish to ESP32 ───────────────────────────────────────────────────────
  try {
    await mqttClient.publishAsync(COMMAND_TOPIC, command, { qos: 1 });

    console.log(`[pump] ✅ Command "${command}" published by user ${req.user._id}`);
    // pump_command Socket.io event is emitted by mqttListener once the broker
    // echoes the message back — this ensures all clients (including those that
    // publish directly to MQTT, e.g. test scripts) update consistently.

    res.json({ ok: true, command, topic: COMMAND_TOPIC });
  } catch (err) {
    console.error('[pump] Failed to publish command:', err.message);
    res.status(500).json({ error: 'Failed to publish command to MQTT broker' });
  }
});

module.exports = router;
