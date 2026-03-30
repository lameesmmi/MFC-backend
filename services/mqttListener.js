'use strict';

/**
 * MQTT Listener Module
 * ────────────────────
 * Orchestrates MQTT connection, message routing, validation, and persistence.
 * Emits validated data to React frontend via Socket.io.
 */

const mqtt = require('mqtt');
const { validateTelemetry } = require('../validations/telemetryValidator');
const { processTelemetryAlerts } = require('./alertService');

// ─────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────

// Changed default fallback to your local broker for safe testing
const BROKER_URL = process.env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883';
const TOPIC_TELEMETRY = 'mfc/system_01/telemetry';
const TOPIC_ALERTS    = 'mfc/system_01/alerts';
const TOPIC_COMMAND   = 'mfc/system/_01/command';
const TOPIC_COMMAND_2 = 'mfc/system/_02/command';

const VALID_COMMANDS       = new Set(['MANUAL_ON', 'MANUAL_OFF', 'AUTO']);
const VALID_PUMP2_COMMANDS = new Set(['MANUAL_ON', 'MANUAL_OFF']);

const MQTT_OPTIONS = {
  clientId:       `mfc-backend-${process.pid}-${Date.now()}`,
  clean:          true,
  reconnectPeriod: 5_000,  // ms between reconnect attempts
  connectTimeout:  30_000, // ms before giving up on initial connect
  // HiveMQ Cloud (or any authenticated broker) credentials — set via env vars
  ...(process.env.MQTT_USERNAME && { username: process.env.MQTT_USERNAME }),
  ...(process.env.MQTT_PASSWORD && { password: process.env.MQTT_PASSWORD }),
};

// ─────────────────────────────────────────────────────────────────────────
// Message handlers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Handles raw MQTT message: parse JSON, route to telemetry or alert path.
 *
 * @param {mqtt.MqttClient} client
 * @param {import('socket.io').Server} io
 * @param {function} SystemLog — Mongoose model
 */
function createMessageHandler(client, io, SystemLog) {
  return async (topic, rawBuffer) => {
    const raw = rawBuffer.toString('utf8').trim();

    // Command topic uses a plain-string payload (not JSON) — handle first.
    // This covers commands from the HTTP route, the test script, or any
    // other MQTT publisher, making this the single source of truth for
    // pump_command Socket.io events.
    if (topic === TOPIC_COMMAND) {
      handleCommand(raw, io);
      return;
    }

    if (topic === TOPIC_COMMAND_2) {
      handleCommand2(raw, io);
      return;
    }

    // All other topics use JSON — malformed frames are dropped immediately.
    let rawPayload;
    try {
      rawPayload = JSON.parse(raw);
    } catch {
      console.warn(
        `[mqttListener] [DROP] Malformed JSON on topic "${topic}":`,
        raw.slice(0, 100)
      );
      return;
    }

    // Route based on topic
    if (topic === TOPIC_ALERTS) {
      handleAlert(rawPayload, io);
      return;
    }

    if (topic === TOPIC_TELEMETRY) {
      await handleTelemetry(rawPayload, io, SystemLog);
      return;
    }

    // Unknown topic
    console.warn(`[mqttListener] Unhandled topic: "${topic}"`);
  };
}

/**
 * Handles a pump command received from the MQTT broker.
 * This fires for commands published by the HTTP route, the test script,
 * or any other MQTT client — making it the single authoritative source
 * for pump_command Socket.io events.
 *
 * @param {string} command  — raw string payload from the broker
 * @param {import('socket.io').Server} io
 */
function handleCommand(command, io) {
  if (!VALID_COMMANDS.has(command)) {
    console.warn(`[mqttListener] Unknown pump command received: "${command}" — ignoring`);
    return;
  }
  console.log(`[mqttListener] 🔧 Pump command confirmed by broker: "${command}"`);
  io.emit('pump_command', { command, timestamp: new Date().toISOString() });
}

/**
 * Handles a Pump 2 command (manual-only: MANUAL_ON / MANUAL_OFF).
 *
 * @param {string} command
 * @param {import('socket.io').Server} io
 */
function handleCommand2(command, io) {
  if (!VALID_PUMP2_COMMANDS.has(command)) {
    console.warn(`[mqttListener] Unknown pump 2 command received: "${command}" — ignoring`);
    return;
  }
  console.log(`[mqttListener] 🔧 Pump 2 command confirmed by broker: "${command}"`);
  io.emit('pump2_command', { command, timestamp: new Date().toISOString() });
}

/**
 * Handles an alert message: bypass validation, emit directly to frontend.
 *
 * @param {object} payload
 * @param {import('socket.io').Server} io
 */
function handleAlert(payload, io) {
  console.log('[mqttListener] 🚨 System alert received:', payload);
  io.emit('system_alert', payload);
}

/**
 * Handles a telemetry message: validate, persist to DB, emit to frontend.
 *
 * @param {object} rawPayload
 * @param {import('socket.io').Server} io
 * @param {function} SystemLog — Mongoose model
 */
async function handleTelemetry(rawPayload, io, SystemLog) {
  // Step 1: Validation gatekeeper (Hard & Soft checks)
  const result = validateTelemetry(rawPayload);

  if (!result.valid) {
    logDroppedPacket(result.reason, rawPayload);
    return;
  }

  // result.payload now contains the EOR { validation: { status, failed_parameters } }
  const validatedData = result.payload;

  // Step 2: Persist to DB asynchronously
  try {
    const newLog = new SystemLog({
        timestamp: validatedData.timestamp,
        metadata: {
            device_id: 'MFC_01', // You can extract this dynamically later if needed
            location: 'Dammam_Lab'
        },
        readings: {
            ph: validatedData.ph,
            tds: validatedData.tds,
            temperature: validatedData.temperature,
            flow_rate: validatedData.flow_rate,
            salinity: validatedData.salinity,
            conductivity: validatedData.conductivity,
            current: validatedData.current,
            voltage: validatedData.voltage,
            power: validatedData.power
        },
        valve_status: validatedData.valve_status,
        validation: validatedData.validation
    });
    
    await newLog.save();
  } catch (err) {
    console.error('[mqttListener] Database persistence failed:', {
        error: err.message,
        timestamp: validatedData.timestamp
    });
  }

  // Step 3: Evaluate thresholds and fire/clear alerts (non-blocking)
  processTelemetryAlerts(io, validatedData);

  // Step 4: Emit to frontend (immediate, non-blocking)
  io.emit('live_telemetry', validatedData);
}

/**
 * Logs details of a dropped telemetry packet.
 */
function logDroppedPacket(reason, payload) {
  console.warn('[mqttListener] [DROP] Telemetry packet rejected', {
    reason,
    timestamp: payload?.timestamp ?? 'N/A'
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Connection lifecycle
// ─────────────────────────────────────────────────────────────────────────

/**
 * Attaches event handlers to the MQTT client for connection lifecycle.
 */
function attachConnectionHandlers(client) {
  client.on('connect', () => {
    console.log(`[mqttListener] ✅ Connected to broker: ${BROKER_URL}`);
    subscribeToTopics(client);
  });

  client.on('reconnect', () => {
    console.warn('[mqttListener] ⚠️ Connection lost — attempting to reconnect…');
  });

  client.on('offline', () => {
    console.warn('[mqttListener] ❌ MQTT client is offline');
  });

  client.on('error', (err) => {
    console.error('[mqttListener] 🔥 MQTT client error:', err.message);
  });
}

/**
 * Subscribes to telemetry and alert topics.
 */
function subscribeToTopics(client) {
  client.subscribe([TOPIC_TELEMETRY, TOPIC_ALERTS, TOPIC_COMMAND, TOPIC_COMMAND_2], { qos: 1 }, (err, granted) => {
    if (err) {
      console.error('[mqttListener] Subscription failed:', err.message);
      return;
    }

    granted.forEach(({ topic, qos }) => {
      console.log(`[mqttListener] 📡 Subscribed to "${topic}" (QoS ${qos})`);
    });
  });
}

/**
 * Attaches graceful shutdown handlers.
 */
function attachShutdownHandlers(client) {
  const shutdown = () => {
    console.log('\n[mqttListener] Closing MQTT connection…');
    client.end(false, {}, () => {
      console.log('[mqttListener] MQTT connection closed. Goodbye.');
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// ─────────────────────────────────────────────────────────────────────────
// Module entry point
// ─────────────────────────────────────────────────────────────────────────

/**
 * Initializes the MQTT listener and wires it to Socket.io and MongoDB.
 *
 * @param   {import('socket.io').Server} io — initialized Socket.io instance
 * @param   {function} SystemLog — Mongoose SystemLog model
 * @returns {mqtt.MqttClient} — the underlying MQTT client
 */
function initMqttListener(io, SystemLog) {
  const client = mqtt.connect(BROKER_URL, MQTT_OPTIONS);

  attachConnectionHandlers(client);
  client.on('message', createMessageHandler(client, io, SystemLog));
  attachShutdownHandlers(client);

  return client;
}

module.exports = initMqttListener;