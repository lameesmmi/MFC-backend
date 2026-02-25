const mqtt = require('mqtt');

const client = mqtt.connect('mqtt://172.20.10.13:1883');

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

    const payload = {
      timestamp:    new Date().toISOString(),
      ph:           round(raw.ph),
      tds:          round(raw.tds, 0),
      temperature:  round(raw.temperature, 1),
      flow_rate:    round(raw.flow_rate, 2),
      salinity:     round(raw.salinity, 0),
      conductivity: round(raw.conductivity, 0),
      current:      round(raw.current, 3),
      voltage:      round(Math.max(-50, Math.min(50, raw.voltage)), 3), // clamp to validator range
      power:        round(raw.power, 3),
      valve_status: raw.valve_status,
    };

    client.publish('mfc/system_01/telemetry', JSON.stringify(payload));

    console.log(
      `[tick ${tick}] Scenario ${scenarioIdx + 1}/${SCENARIOS.length}: ${scenario.name}\n` +
      `  pH=${payload.ph}  TDS=${payload.tds}  Temp=${payload.temperature}°C  Flow=${payload.flow_rate}L/min  V=${payload.voltage}V\n`
    );

    tick++;
  }, INTERVAL_MS);
});

client.on('error', err => console.error('❌ MQTT error:', err.message));
