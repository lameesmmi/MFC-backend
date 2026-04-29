

require('dotenv').config(); // This loads variables from your .env file
const mqtt = require('mqtt');

// 1. Define your HiveMQ credentials
const options = {
  username: process.env.MQTT_USERNAME || 'YOUR_HIVEMQ_USERNAME', 
  password: process.env.MQTT_PASSWORD || 'YOUR_HIVEMQ_PASSWORD'
};

// 2. Connect using BOTH the secure URL and the options
const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtts://YOUR_CLUSTER_URL.s1.eu.hivemq.cloud:8883';
const client = mqtt.connect(brokerUrl, options);

const PREFIX           = process.env.MQTT_TOPIC_PREFIX ?? '';
const TOPIC_TELEMETRY  = `${PREFIX}mfc/system_01/telemetry`;



// ─── Scenario cycle ───────────────────────────────────────────────────────────
// The mock rotates through scenarios so alerts fire AND clear automatically.
// Each scenario runs for SCENARIO_TICKS ticks before advancing.

const INTERVAL_MS    = 5000; // send every 5 s
const SCENARIO_TICKS = 4;    // ticks per scenario (~20 s each)

const SCENARIOS = [
  {
    name: 'Normal — all sensors safe',
    data: () => ({
      ph:          7.0 + rand(-0.2, 0.2),
      tds:         800 + rand(-100, 100),
      temperature: 25  + rand(-1, 1),
      flow_rate:   1.5 + rand(-0.2, 0.2),
      salinity:    300 + rand(-20, 20),
      conductivity:400 + rand(-30, 30),
      current:     0.5 + rand(-0.05, 0.05),
      voltage:     1.2 + rand(-0.1, 0.1),
      power:       0.6 + rand(-0.05, 0.05),
      valve_status:'OPEN',
    }),
  },
  {
    name: 'PARTIAL — water quality sensors offline (no ph/tds/salinity/conductivity)',
    data: () => ({
      // ph, tds, salinity, conductivity omitted — sensors offline
      temperature: 26  + rand(-1, 1),
      flow_rate:   1.6 + rand(-0.1, 0.1),
      current:     0.55,
      voltage:     1.25,
      power:       0.69,
      valve_status:'OPEN',
    }),
  },
  {
    name: 'pH too low — warning expected',
    data: () => ({
      ph:          5.8 + rand(-0.3, 0.3),   // below 6.5 → alert
      tds:         900 + rand(-50, 50),
      temperature: 24  + rand(-1, 1),
      flow_rate:   1.4 + rand(-0.1, 0.1),
      salinity:    310,
      conductivity:410,
      current:     0.5,
      voltage:     1.1,
      power:       0.55,
      valve_status:'OPEN',
    }),
  },
  {
    name: 'TDS too high — warning expected',
    data: () => ({
      ph:          7.1 + rand(-0.2, 0.2),
      tds:         5500 + rand(-200, 200),  // above 5000 → alert
      temperature: 26  + rand(-1, 1),
      flow_rate:   1.6 + rand(-0.1, 0.1),
      salinity:    2800,
      conductivity:5600,
      current:     0.5,
      voltage:     1.2,
      power:       0.6,
      valve_status:'OPEN',
    }),
  },
  {
    name: 'Temperature high — warning expected',
    data: () => ({
      ph:          7.0 + rand(-0.1, 0.1),
      tds:         850 + rand(-50, 50),
      temperature: 43  + rand(-0.5, 0.5),  // above 40 → alert
      flow_rate:   1.5 + rand(-0.1, 0.1),
      salinity:    300,
      conductivity:400,
      current:     0.6,
      voltage:     1.3,
      power:       0.78,
      valve_status:'OPEN',
    }),
  },
  {
    name: 'Flow rate too low — warning expected',
    data: () => ({
      ph:          6.9 + rand(-0.2, 0.2),
      tds:         750 + rand(-50, 50),
      temperature: 25  + rand(-1, 1),
      flow_rate:   0.2 + rand(-0.05, 0.05), // below 0.5 → alert
      salinity:    280,
      conductivity:380,
      current:     0.3,
      voltage:     0.9,
      power:       0.27,
      valve_status:'CLOSED',
    }),
  },
  {
    name: 'pH high — warning expected',
    data: () => ({
      ph:          9.2 + rand(-0.2, 0.2),   // above 8.5 → alert
      tds:         920 + rand(-80, 80),
      temperature: 27  + rand(-1, 1),
      flow_rate:   1.8 + rand(-0.2, 0.2),
      salinity:    320,
      conductivity:420,
      current:     0.55,
      voltage:     1.25,
      power:       0.69,
      valve_status:'OPEN',
    }),
  },
  {
    name: 'Multiple sensors unsafe',
    data: () => ({
      ph:          5.5 + rand(-0.2, 0.2),   // too low → alert
      tds:         6000 + rand(-200, 200),  // too high → alert
      temperature: 44  + rand(-0.5, 0.5),  // too high → alert
      flow_rate:   1.5,
      salinity:    3100,
      conductivity:6100,
      current:     0.7,
      voltage:     1.4,
      power:       0.98,
      valve_status:'OPEN',
    }),
  },

  // ── Partial-packet scenarios (some sensors offline) ────────────────────────
  {
    name: 'PARTIAL — pH sensor offline',
    data: () => ({
      // ph omitted — sensor offline
      tds:         900 + rand(-50, 50),
      temperature: 25  + rand(-1, 1),
      flow_rate:   1.5 + rand(-0.1, 0.1),
      salinity:    300,
      conductivity:400,
      current:     0.5,
      voltage:     1.2,
      power:       0.6,
      valve_status:'OPEN',
    }),
  },
  {
    name: 'PARTIAL — electrical sensors offline (no current/voltage/power)',
    data: () => ({
      ph:          7.0 + rand(-0.2, 0.2),
      tds:         850 + rand(-50, 50),
      temperature: 24  + rand(-1, 1),
      flow_rate:   1.4 + rand(-0.1, 0.1),
      salinity:    290,
      conductivity:390,
      // current, voltage, power omitted — sensor offline
      valve_status:'OPEN',
    }),
  },
  
  {
    name: 'PARTIAL — valve sensor offline (no valve_status)',
    data: () => ({
      ph:          7.2 + rand(-0.2, 0.2),
      tds:         950 + rand(-50, 50),
      temperature: 25  + rand(-1, 1),
      flow_rate:   1.5 + rand(-0.1, 0.1),
      salinity:    310,
      conductivity:410,
      current:     0.5,
      voltage:     1.2,
      power:       0.6,
      // valve_status omitted — sensor offline
    }),
  },
  {
    name: 'PARTIAL — only temperature and flow_rate available',
    data: () => ({
      // all other sensors offline
      temperature: 25  + rand(-1, 1),
      flow_rate:   1.5 + rand(-0.1, 0.1),
    }),
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function round(n, decimals = 2) {
  return parseFloat(n.toFixed(decimals));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

client.on('connect', () => {
  console.log('✅ Mock ESP32 connected to broker!');
  console.log(`📋 Cycling through ${SCENARIOS.length} scenarios, ${SCENARIO_TICKS} ticks each (~${(SCENARIO_TICKS * INTERVAL_MS / 1000)}s per scenario)\n`);

  let tick = 0;

  setInterval(() => {
    const scenarioIdx = Math.floor(tick / SCENARIO_TICKS) % SCENARIOS.length;
    const scenario    = SCENARIOS[scenarioIdx];
    const raw         = scenario.data();

    // Only include fields the scenario actually provided — absent fields mean sensor is offline
    const payload = {
      timestamp: new Date().toISOString(),
      ...(raw.ph           !== undefined && { ph:           round(raw.ph) }),
      ...(raw.tds          !== undefined && { tds:          round(raw.tds, 0) }),
      ...(raw.temperature  !== undefined && { temperature:  round(raw.temperature, 1) }),
      ...(raw.flow_rate    !== undefined && { flow_rate:    round(raw.flow_rate, 2) }),
      ...(raw.salinity     !== undefined && { salinity:     round(raw.salinity, 0) }),
      ...(raw.conductivity !== undefined && { conductivity: round(raw.conductivity, 0) }),
      ...(raw.current      !== undefined && { current:      round(raw.current, 3) }),
      ...(raw.voltage      !== undefined && { voltage:      round(Math.max(-50, Math.min(50, raw.voltage)), 3) }),
      ...(raw.power        !== undefined && { power:        round(raw.power, 3) }),
      ...(raw.valve_status !== undefined && { valve_status: raw.valve_status }),
    };

    client.publish(TOPIC_TELEMETRY, JSON.stringify(payload));

    const ALL_FIELDS = ['ph', 'tds', 'temperature', 'flow_rate', 'salinity', 'conductivity', 'current', 'voltage', 'power', 'valve_status'];
    const missing = ALL_FIELDS.filter(f => !(f in payload));
    console.log(
      `[tick ${tick}] Scenario ${scenarioIdx + 1}/${SCENARIOS.length}: ${scenario.name}\n` +
      `  pH=${payload.ph ?? '—'}  TDS=${payload.tds ?? '—'}  Temp=${payload.temperature ?? '—'}°C  Flow=${payload.flow_rate ?? '—'}L/min  V=${payload.voltage ?? '—'}V\n` +
      (missing.length ? `  ⚠️  Offline sensors: ${missing.join(', ')}\n` : '')
    );

    tick++;
  }, INTERVAL_MS);
});

client.on('error', err => console.error('❌ MQTT error:', err.message));
