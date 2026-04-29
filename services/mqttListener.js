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

// ─────────────────────────────────────────────────────────────────────────
// Telemetry aggregation (multi-ESP32 support)
// ─────────────────────────────────────────────────────────────────────────
//
// When multiple ESP32 clients each publish a subset of sensors, back-to-back
// messages would otherwise cause the dashboard to see rapid partial updates
// (e.g. one message has ph/temp, the next has tds/flow).  We collect all
// fields that arrive within a 150 ms window and emit one merged payload so
// the frontend always gets a complete, unified reading.

const AGGREGATION_WINDOW_MS = 150;
// Fields forwarded from validated telemetry to the aggregated payload.
const AGGREGATED_FIELDS = [
  'ph', 'tds', 'temperature', 'flow_rate', 'salinity',
  'conductivity', 'voltage', 'current', 'power',
  'valve_status', 'timestamp', 'validation',
];

let _pendingFields = {};
let _emitTimer    = null;

/**
 * Merges `validatedData` into the pending aggregate and schedules a single
 * Socket.io emission after AGGREGATION_WINDOW_MS.  Subsequent calls within
 * the same window extend the merged payload without resetting the timer.
 *
 * @param {object} validatedData
 * @param {import('socket.io').Server} io
 */
function mergeAndScheduleEmit(validatedData, io) {
  for (const field of AGGREGATED_FIELDS) {
    if (validatedData[field] != null) {
      _pendingFields[field] = validatedData[field];
    }
  }

  if (_emitTimer) return; // already scheduled for this window
  _emitTimer = setTimeout(() => {
    io.emit('live_telemetry', { ..._pendingFields });
    _pendingFields = {};
    _emitTimer    = null;
  }, AGGREGATION_WINDOW_MS);
}
const PREFIX          = process.env.MQTT_TOPIC_PREFIX ?? '';
const TOPIC_TELEMETRY = `${PREFIX}mfc/system_01/telemetry`;
const TOPIC_ALERTS    = `${PREFIX}mfc/system_01/alerts`;
const TOPIC_COMMAND   = `${PREFIX}mfc/system/_01/command`;
const TOPIC_COMMAND_2 = `${PREFIX}mfc/system/_02/command`;
const TOPIC_COMMAND_3 = `${PREFIX}mfc/system/_03/command`;

const VALID_COMMANDS       = new Set(['MANUAL_ON', 'MANUAL_OFF', 'AUTO']);
const VALID_PUMP2_COMMANDS = new Set(['MANUAL_ON', 'MANUAL_OFF', 'AUTO']);
const VALID_PUMP3_COMMANDS = new Set(['MANUAL_ON', 'MANUAL_OFF', 'AUTO']);

// ─── Pump state store ─────────────────────────────────────────────────────────
//
// Tracks the last-known command for each pump so that newly connecting
// Socket.io clients can be synced immediately instead of waiting for the
// next MQTT message to arrive.

const pumpState = {
  pump1: 'AUTO',
  pump2: 'MANUAL_OFF',
  pump3: 'MANUAL_OFF',
};

/** Returns a snapshot of the current pump states. */
function getPumpState() {
  return { ...pumpState };
}

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

    if (topic === TOPIC_COMMAND_3) {
      handleCommand3(raw, io);
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
  pumpState.pump1 = command;
  console.log(`[mqttListener] 🔧 Pump 1 command confirmed by broker: "${command}"`);
  io.emit('pump_command', { command, timestamp: new Date().toISOString() });
}

/**
 * Handles a Pump 2 command (MANUAL_ON / MANUAL_OFF / AUTO).
 *
 * @param {string} command
 * @param {import('socket.io').Server} io
 */
function handleCommand2(command, io) {
  if (!VALID_PUMP2_COMMANDS.has(command)) {
    console.warn(`[mqttListener] Unknown pump 2 command received: "${command}" — ignoring`);
    return;
  }
  pumpState.pump2 = command;
  console.log(`[mqttListener] 🔧 Pump 2 command confirmed by broker: "${command}"`);
  io.emit('pump2_command', { command, timestamp: new Date().toISOString() });
}

/**
 * Handles a Pump 3 command (MANUAL_ON / MANUAL_OFF / AUTO).
 *
 * @param {string} command
 * @param {import('socket.io').Server} io
 */
function handleCommand3(command, io) {
  if (!VALID_PUMP3_COMMANDS.has(command)) {
    console.warn(`[mqttListener] Unknown pump 3 command received: "${command}" — ignoring`);
    return;
  }
  pumpState.pump3 = command;
  console.log(`[mqttListener] 🔧 Pump 3 command confirmed by broker: "${command}"`);
  io.emit('pump3_command', { command, timestamp: new Date().toISOString() });
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

  // Step 4: Merge into the aggregation window and schedule a single emit.
  // Multiple ESP32 clients publishing within 150 ms are bundled into one
  // Socket.io event so the dashboard sees a unified, complete reading.
  mergeAndScheduleEmit(validatedData, io);
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
  client.subscribe([TOPIC_TELEMETRY, TOPIC_ALERTS, TOPIC_COMMAND, TOPIC_COMMAND_2, TOPIC_COMMAND_3], { qos: 1 }, (err, granted) => {
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

module.exports = { initMqttListener, getPumpState };