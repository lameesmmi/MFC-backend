'use strict';

/**
 * Pump Command Test Script
 * ────────────────────────
 * Connects to the MQTT broker and exercises the pump command topic.
 *
 * Two modes (pick one via CLI flag):
 *
 *   node test_pump_command.js
 *     Default — publishes all three commands in sequence (3 s apart) while
 *     simultaneously subscribing to the same topic so you can see exactly
 *     what the ESP32 would receive.
 *
 *   node test_pump_command.js --listen
 *     Listen-only — subscribes and prints every command that arrives.
 *     Useful when running alongside the real backend to verify that
 *     POST /api/pump/command actually reaches the broker.
 *
 * Uses the same env vars as the rest of the project (.env file):
 *   MQTT_BROKER_URL  — e.g. mqtts://xyz.hivemq.cloud:8883
 *   MQTT_USERNAME
 *   MQTT_PASSWORD
 */

require('dotenv').config();
const mqtt = require('mqtt');

// ─── Configuration ────────────────────────────────────────────────────────────

const PREFIX           = process.env.MQTT_TOPIC_PREFIX ?? '';
const COMMAND_TOPIC    = `${PREFIX}mfc/system/_01/command`;
const COMMANDS         = ['MANUAL_ON', 'MANUAL_OFF', 'AUTO'];
const COMMAND_DELAY_MS = 3_000;   // pause between each published command
const LINGER_MS        = 5_000;   // wait after last command before disconnecting

const LISTEN_ONLY = process.argv.includes('--listen');

// ─── What each command means (mirrors ESP32 firmware logic) ──────────────────

const COMMAND_EFFECTS = {
  MANUAL_ON:  'Pump turns ON  — automatic sensor loop is locked out',
  MANUAL_OFF: 'Pump turns OFF — automatic sensor loop is locked out',
  AUTO:       'Manual override released — ESP32 resumes automatic sensor control',
};

const COMMAND_ICONS = {
  MANUAL_ON:  '🟢',
  MANUAL_OFF: '🔴',
  AUTO:       '🔄',
};

// ─── MQTT client ──────────────────────────────────────────────────────────────

const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtts://YOUR_CLUSTER_URL.s1.eu.hivemq.cloud:8883';

const client = mqtt.connect(brokerUrl, {
  clientId:        `mfc-pump-test-${process.pid}-${Date.now()}`,
  clean:           true,
  reconnectPeriod: 0,  // no auto-reconnect — this is a one-shot test
  connectTimeout:  10_000,
  ...(process.env.MQTT_USERNAME && { username: process.env.MQTT_USERNAME }),
  ...(process.env.MQTT_PASSWORD && { password: process.env.MQTT_PASSWORD }),
});

// ─── Connection lifecycle ─────────────────────────────────────────────────────

client.on('connect', () => {
  console.log(`✅ Connected to broker: ${brokerUrl}`);
  console.log(`📋 Mode: ${LISTEN_ONLY ? 'LISTEN ONLY (waiting for backend commands)' : 'PUBLISH + LISTEN (full cycle test)'}\n`);

  client.subscribe(COMMAND_TOPIC, { qos: 1 }, (err) => {
    if (err) {
      console.error('❌ Subscription failed:', err.message);
      return exit(1);
    }
    console.log(`📡 Subscribed to "${COMMAND_TOPIC}"\n`);

    if (LISTEN_ONLY) {
      console.log('Waiting for commands from the backend…  (Ctrl-C to stop)\n');
    } else {
      publishNext(0);
    }
  });
});

// ─── Incoming message handler (simulates ESP32 receive side) ─────────────────

client.on('message', (_topic, rawPayload) => {
  const command = rawPayload.toString('utf8').trim();
  const icon    = COMMAND_ICONS[command]  ?? '❓';
  const effect  = COMMAND_EFFECTS[command] ?? 'Unknown command — ESP32 would ignore this';

  console.log(`${icon} Received: "${command}"`);
  console.log(`   → ${effect}\n`);
});

// ─── Publisher (default mode) ─────────────────────────────────────────────────

/**
 * Publishes each command in COMMANDS one at a time, waits COMMAND_DELAY_MS
 * between each, then lingers for LINGER_MS before disconnecting cleanly.
 */
function publishNext(index) {
  if (index >= COMMANDS.length) {
    console.log(`All ${COMMANDS.length} commands sent.\nListening for echoes for ${LINGER_MS / 1000} more seconds…\n`);
    setTimeout(() => exit(0), LINGER_MS);
    return;
  }

  const command = COMMANDS[index];
  console.log(`── [${index + 1}/${COMMANDS.length}] Publishing: "${command}" ──────────────────`);

  client.publish(COMMAND_TOPIC, command, { qos: 1 }, (err) => {
    if (err) {
      console.error(`   ❌ Publish failed: ${err.message}`);
    }
    // Schedule next command regardless of publish error so the full cycle runs
    setTimeout(() => publishNext(index + 1), COMMAND_DELAY_MS);
  });
}

// ─── Error / offline handlers ─────────────────────────────────────────────────

client.on('error',   err => console.error('❌ MQTT error:', err.message));
client.on('offline', ()  => console.warn( '⚠️  Broker offline'));

// ─── Clean exit ───────────────────────────────────────────────────────────────

function exit(code = 0) {
  client.end(false, {}, () => {
    console.log(code === 0 ? '\nTest complete. Disconnected.' : '\nAborted.');
    process.exit(code);
  });
}

process.on('SIGINT',  () => { console.log('\nInterrupted.'); exit(0); });
process.on('SIGTERM', () => exit(0));
