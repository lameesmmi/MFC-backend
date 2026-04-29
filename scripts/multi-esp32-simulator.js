'use strict';

/**
 * Multi-ESP32 MQTT Simulator
 * ──────────────────────────
 * Simulates multiple ESP32 clients each publishing a different subset of
 * sensors to the same telemetry topic. Use this to verify that the dashboard
 * correctly aggregates readings from multiple clients without flashing sensors
 * as offline.
 *
 * Usage:
 *   node scripts/multi-esp32-simulator.js [scenario]
 *
 * Scenarios:
 *   normal     (default) — two ESP32s publish every 2 s, offset by 1 s
 *   rapid      — two ESP32s fire within 100 ms of each other (tests 150ms window)
 *   dropout    — ESP32-B stops after 10 s (tests per-sensor offline timeout)
 *   three      — three ESP32s each with different sensors
 *   single     — single ESP32 with all sensors (baseline / sanity check)
 *
 * Reads broker credentials from ../.env automatically.
 */

const path   = require('path');
const fs     = require('fs');
const mqtt   = require('mqtt');

// ─── Load .env ────────────────────────────────────────────────────────────────
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach(line => {
      const [key, ...rest] = line.trim().split('=');
      if (key && rest.length) process.env[key] = rest.join('=');
    });
}

const BROKER_URL = process.env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883';
const PREFIX     = process.env.MQTT_TOPIC_PREFIX ?? '';
const TOPIC      = `${PREFIX}mfc/system_01/telemetry`;

// ─── Colour helpers ───────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  magenta:'\x1b[35m',
  red:    '\x1b[31m',
  dim:    '\x1b[2m',
};
const colour = (c, s) => `${c}${s}${C.reset}`;

// ─── Realistic sensor value generators ────────────────────────────────────────
const rand = (min, max, decimals = 2) =>
  parseFloat((Math.random() * (max - min) + min).toFixed(decimals));

const generators = {
  ph:           () => rand(6.8, 7.8),
  tds:          () => rand(800, 2000, 0),
  temperature:  () => rand(22, 30),
  flow_rate:    () => rand(0.5, 3.5),
  salinity:     () => rand(1.0, 3.5),
  conductivity: () => rand(1500, 4000, 0),
  voltage:      () => rand(11.5, 13.0),
  current:      () => rand(0.8, 2.5),
  valve_status: () => (Math.random() > 0.9 ? 'CLOSED' : 'OPEN'),
};

function buildPayload(fields) {
  const payload = { timestamp: new Date().toISOString() };
  for (const f of fields) {
    payload[f] = generators[f]();
  }
  return payload;
}

// ─── ESP32 client factory ─────────────────────────────────────────────────────
function createClient(name, colourCode) {
  const clientId = `esp32-sim-${name}-${Date.now()}`;
  const client = mqtt.connect(BROKER_URL, {
    clientId,
    clean: true,
    ...(process.env.MQTT_USERNAME && { username: process.env.MQTT_USERNAME }),
    ...(process.env.MQTT_PASSWORD && { password: process.env.MQTT_PASSWORD }),
  });

  client.on('connect', () =>
    console.log(colour(colourCode, `[${name}] ✅ Connected (clientId: ${clientId})`)));
  client.on('error',   err =>
    console.error(colour(C.red, `[${name}] ❌ Error: ${err.message}`)));
  client.on('offline', () =>
    console.warn(colour(C.red, `[${name}] ⚠️  Offline`)));

  return {
    name, colourCode, client,
    publish(fields) {
      const payload = buildPayload(fields);
      const json    = JSON.stringify(payload);
      client.publish(TOPIC, json, { qos: 1 }, err => {
        if (err) return console.error(colour(C.red, `[${name}] publish error: ${err.message}`));
        const vals = fields.map(f => `${f}=${colour(C.bold, payload[f])}`).join('  ');
        console.log(colour(colourCode, `[${name}]`) + ` → ${vals}`);
      });
    },
    end() { client.end(); },
  };
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * normal — two ESP32s, 2 s cycle, offset by 1 s.
 * Verifies that sensors from A don't flash offline when B publishes.
 */
async function scenarioNormal() {
  console.log(colour(C.bold, '\n=== Scenario: NORMAL (2 s cycle, 1 s offset) ==='));
  console.log(colour(C.dim, 'ESP32-A: ph, temperature, flow_rate, valve_status'));
  console.log(colour(C.dim, 'ESP32-B: tds, salinity, conductivity, voltage, current\n'));

  const a = createClient('ESP32-A', C.cyan);
  const b = createClient('ESP32-B', C.green);

  await wait(1500); // let both connect

  const INTERVAL = 2000;
  let tick = 0;

  const timerA = setInterval(() => {
    a.publish(['ph', 'temperature', 'flow_rate', 'valve_status']);
    tick++;
    if (tick >= 20) {
      clearInterval(timerA);
      clearInterval(timerB);
      console.log(colour(C.bold, '\n[sim] Done — 20 cycles complete.'));
      a.end(); b.end();
    }
  }, INTERVAL);

  await wait(1000); // offset B by 1 s

  const timerB = setInterval(() => {
    b.publish(['tds', 'salinity', 'conductivity', 'voltage', 'current']);
  }, INTERVAL);
}

/**
 * rapid — both ESP32s fire within 100 ms.
 * Tests the 150 ms aggregation window on the backend.
 */
async function scenarioRapid() {
  console.log(colour(C.bold, '\n=== Scenario: RAPID (both within 100 ms) ==='));
  console.log(colour(C.dim, 'Both clients publish almost simultaneously — backend should merge into one Socket.io event.\n'));

  const a = createClient('ESP32-A', C.cyan);
  const b = createClient('ESP32-B', C.green);

  await wait(1500);

  let tick = 0;
  const timerA = setInterval(async () => {
    a.publish(['ph', 'temperature', 'flow_rate']);
    await wait(80); // 80 ms later — within the 150 ms aggregation window
    b.publish(['tds', 'salinity', 'conductivity', 'voltage', 'current']);
    tick++;
    if (tick >= 15) {
      clearInterval(timerA);
      console.log(colour(C.bold, '\n[sim] Done — 15 rapid cycles complete.'));
      a.end(); b.end();
    }
  }, 2000);
}

/**
 * dropout — ESP32-B stops publishing after 10 s.
 * Verifies that B's sensors go individually offline after SENSOR_TIMEOUT_MS
 * while A's sensors remain live.
 */
async function scenarioDropout() {
  console.log(colour(C.bold, '\n=== Scenario: DROPOUT (B drops after 10 s) ==='));
  console.log(colour(C.dim, 'After 10 s, ESP32-B will stop. Watch TDS/salinity/conductivity go offline while ph/temp stay live.\n'));

  const a = createClient('ESP32-A', C.cyan);
  const b = createClient('ESP32-B', C.yellow);

  await wait(1500);

  const timerA = setInterval(() => a.publish(['ph', 'temperature', 'flow_rate']), 2000);
  const timerB = setInterval(() => b.publish(['tds', 'salinity', 'conductivity', 'voltage', 'current']), 2000);

  await wait(10_000);
  clearInterval(timerB);
  console.log(colour(C.yellow, '\n[ESP32-B] 🔌 Simulating power-loss — stopped publishing.'));
  console.log(colour(C.dim, '[sim] ESP32-A continues. TDS/salinity/conductivity should go offline in ~15 s.\n'));

  await wait(20_000);
  clearInterval(timerA);
  console.log(colour(C.bold, '\n[sim] Done.'));
  a.end(); b.end();
}

/**
 * three — three ESP32s, each with different sensors, 2 s cycle.
 */
async function scenarioThree() {
  console.log(colour(C.bold, '\n=== Scenario: THREE ESP32 clients ==='));
  console.log(colour(C.dim, 'ESP32-A: ph, temperature'));
  console.log(colour(C.dim, 'ESP32-B: tds, salinity, conductivity'));
  console.log(colour(C.dim, 'ESP32-C: voltage, current, flow_rate, valve_status\n'));

  const a = createClient('ESP32-A', C.cyan);
  const b = createClient('ESP32-B', C.green);
  const c = createClient('ESP32-C', C.magenta);

  await wait(1500);

  let tick = 0;
  const timerA = setInterval(() => { a.publish(['ph', 'temperature']); tick++; }, 2000);
  await wait(600);
  const timerB = setInterval(() => b.publish(['tds', 'salinity', 'conductivity']), 2000);
  await wait(600);
  const timerC = setInterval(async () => {
    c.publish(['voltage', 'current', 'flow_rate', 'valve_status']);
    if (tick >= 20) {
      clearInterval(timerA); clearInterval(timerB); clearInterval(timerC);
      console.log(colour(C.bold, '\n[sim] Done — 20 cycles complete.'));
      a.end(); b.end(); c.end();
    }
  }, 2000);
}

/**
 * single — one ESP32 with all sensors (sanity check baseline).
 */
async function scenarioSingle() {
  console.log(colour(C.bold, '\n=== Scenario: SINGLE ESP32 (all sensors) ==='));
  console.log(colour(C.dim, 'Baseline sanity check — all sensors in every message.\n'));

  const a = createClient('ESP32-A', C.cyan);
  await wait(1500);

  let tick = 0;
  const timer = setInterval(() => {
    a.publish(['ph', 'tds', 'temperature', 'flow_rate', 'salinity', 'conductivity', 'voltage', 'current', 'valve_status']);
    tick++;
    if (tick >= 15) {
      clearInterval(timer);
      console.log(colour(C.bold, '\n[sim] Done — 15 cycles complete.'));
      a.end();
    }
  }, 2000);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const SCENARIOS = { normal: scenarioNormal, rapid: scenarioRapid, dropout: scenarioDropout, three: scenarioThree, single: scenarioSingle };
const arg      = process.argv[2] ?? 'normal';
const run      = SCENARIOS[arg];

if (!run) {
  console.error(colour(C.red, `Unknown scenario "${arg}". Available: ${Object.keys(SCENARIOS).join(', ')}`));
  process.exit(1);
}

console.log(colour(C.bold + C.cyan, '\nMFC Multi-ESP32 Simulator'));
console.log(colour(C.dim, `Broker : ${BROKER_URL}`));
console.log(colour(C.dim, `Topic  : ${TOPIC}${PREFIX ? '  (prefixed — local test mode)' : ''}\n`));

run().catch(err => {
  console.error(colour(C.red, `[sim] Fatal: ${err.message}`));
  process.exit(1);
});
