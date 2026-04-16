'use strict';

/**
 * Pump Sync Test — Multi-Client Socket.io Simulator
 * ──────────────────────────────────────────────────
 * Spawns multiple Socket.io clients that behave like browser dashboard tabs.
 * Verifies that:
 *   1. Every new client receives the current pump state immediately on connect
 *      (pump_state_sync event).
 *   2. When one client sends a pump command via HTTP, all other clients see
 *      the update within milliseconds via pump_command / pump2_command /
 *      pump3_command Socket.io events.
 *   3. AUTO mode is accepted for all three pumps.
 *
 * Usage:
 *   node scripts/pump-sync-test.js
 *
 * Requires the backend server to be running (npm run dev / node server.js).
 * Reads BACKEND_URL and TEST_TOKEN from ../.env automatically.
 */

const path = require('path');
const fs   = require('fs');
const { io: ioClient } = require('socket.io-client');

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

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:5000';
const TOKEN       = process.env.TEST_TOKEN;

if (!TOKEN) {
  console.error('[pump-sync-test] ❌  TEST_TOKEN not set in .env — add a valid JWT.');
  process.exit(1);
}

// ─── Colours ──────────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
};
const c = (col, s) => `${col}${s}${C.reset}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const wait = ms => new Promise(r => setTimeout(r, ms));

function ts() {
  return c(C.dim, new Date().toLocaleTimeString('en-US', { hour12: false }));
}

async function httpCommand(endpoint, command) {
  const res = await fetch(`${BACKEND_URL}${endpoint}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ command }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`HTTP ${res.status}: ${body.error ?? res.statusText}`);
  }
  return res.json();
}

// ─── Client factory ───────────────────────────────────────────────────────────
function createSocketClient(name, colourCode) {
  const socket = ioClient(BACKEND_URL, {
    auth: { token: TOKEN },
    transports: ['websocket'],
  });

  const log = (msg) => console.log(`${ts()} ${c(colourCode, `[${name}]`)} ${msg}`);

  const received = {
    pumpStateSync:  null,   // first pump_state_sync payload
    pumpCommands:   [],     // { pump, command, at }
  };

  socket.on('connect', () =>
    log(c(C.green, `connected  (id: ${socket.id})`)));

  socket.on('connect_error', err =>
    log(c(C.red, `connect error: ${err.message}`)));

  socket.on('disconnect', () =>
    log(c(C.yellow, 'disconnected')));

  socket.on('pump_state_sync', (state) => {
    received.pumpStateSync = state;
    log(
      c(C.bold, 'pump_state_sync') +
      `  pump1=${c(C.cyan, state.pump1)}` +
      `  pump2=${c(C.cyan, state.pump2)}` +
      `  pump3=${c(C.cyan, state.pump3)}`
    );
  });

  socket.on('pump_command',  ({ command }) => {
    received.pumpCommands.push({ pump: 1, command, at: Date.now() });
    log(`pump_command   pump1 → ${c(C.yellow, command)}`);
  });
  socket.on('pump2_command', ({ command }) => {
    received.pumpCommands.push({ pump: 2, command, at: Date.now() });
    log(`pump2_command  pump2 → ${c(C.yellow, command)}`);
  });
  socket.on('pump3_command', ({ command }) => {
    received.pumpCommands.push({ pump: 3, command, at: Date.now() });
    log(`pump3_command  pump3 → ${c(C.yellow, command)}`);
  });

  return { name, socket, received, log };
}

// ─── Test runner ──────────────────────────────────────────────────────────────
async function runTests() {
  console.log(c(C.bold + C.cyan, '\n══════════════════════════════════════════'));
  console.log(c(C.bold + C.cyan,   '  MFC Pump Sync Test — Multi-Client'));
  console.log(c(C.bold + C.cyan,   '══════════════════════════════════════════'));
  console.log(c(C.dim, `  Backend : ${BACKEND_URL}`));
  console.log(c(C.dim, `  Token   : ${TOKEN.slice(0, 20)}…\n`));

  let passed = 0;
  let failed = 0;

  function assert(label, condition) {
    if (condition) {
      console.log(c(C.green, `  ✓ PASS`) + `  ${label}`);
      passed++;
    } else {
      console.log(c(C.red,   `  ✗ FAIL`) + `  ${label}`);
      failed++;
    }
  }

  // ── Phase 1: connect Client A, set known state ────────────────────────────
  console.log(c(C.bold, '\n── Phase 1: establish known pump state ──────────────────────\n'));

  const clientA = createSocketClient('Client-A', C.cyan);
  await wait(1500); // let it connect and receive pump_state_sync

  // Drive pumps to a known baseline: pump1=AUTO, pump2=MANUAL_OFF, pump3=MANUAL_OFF
  console.log(c(C.dim, '\n  [test] Setting baseline: pump1=AUTO pump2=MANUAL_OFF pump3=MANUAL_OFF'));
  try {
    await httpCommand('/api/pump/command',  'AUTO');        await wait(400);
    await httpCommand('/api/pump/command2', 'MANUAL_OFF');  await wait(400);
    await httpCommand('/api/pump/command3', 'MANUAL_OFF');  await wait(400);
  } catch (err) {
    console.error(c(C.red, `  [ERROR] HTTP command failed: ${err.message}`));
    console.error(c(C.red, '  Is the backend server running?'));
    clientA.socket.disconnect();
    process.exit(1);
  }

  await wait(500);

  // ── Phase 2: connect Client B — verify instant state sync ────────────────
  console.log(c(C.bold, '\n── Phase 2: new client receives state immediately on connect ─\n'));

  const clientB = createSocketClient('Client-B', C.magenta);
  await wait(1500);

  assert(
    'Client-B received pump_state_sync on connect',
    clientB.received.pumpStateSync !== null,
  );
  assert(
    'pump_state_sync has pump1=AUTO',
    clientB.received.pumpStateSync?.pump1 === 'AUTO',
  );
  assert(
    'pump_state_sync has pump2=MANUAL_OFF',
    clientB.received.pumpStateSync?.pump2 === 'MANUAL_OFF',
  );
  assert(
    'pump_state_sync has pump3=MANUAL_OFF',
    clientB.received.pumpStateSync?.pump3 === 'MANUAL_OFF',
  );

  // ── Phase 3: connect Client C after changing state ────────────────────────
  console.log(c(C.bold, '\n── Phase 3: state is updated before a third client joins ────\n'));

  console.log(c(C.dim, '  [test] Changing: pump1=MANUAL_ON pump2=AUTO pump3=AUTO'));
  await httpCommand('/api/pump/command',  'MANUAL_ON');  await wait(400);
  await httpCommand('/api/pump/command2', 'AUTO');        await wait(400);
  await httpCommand('/api/pump/command3', 'AUTO');        await wait(400);
  await wait(600);

  // Verify A and B both got the live updates
  const aGotP1 = clientA.received.pumpCommands.some(e => e.pump === 1 && e.command === 'MANUAL_ON');
  const aGotP2 = clientA.received.pumpCommands.some(e => e.pump === 2 && e.command === 'AUTO');
  const aGotP3 = clientA.received.pumpCommands.some(e => e.pump === 3 && e.command === 'AUTO');
  const bGotP1 = clientB.received.pumpCommands.some(e => e.pump === 1 && e.command === 'MANUAL_ON');
  const bGotP2 = clientB.received.pumpCommands.some(e => e.pump === 2 && e.command === 'AUTO');
  const bGotP3 = clientB.received.pumpCommands.some(e => e.pump === 3 && e.command === 'AUTO');

  assert('Client-A received pump1=MANUAL_ON via socket',  aGotP1);
  assert('Client-A received pump2=AUTO via socket',        aGotP2);
  assert('Client-A received pump3=AUTO via socket',        aGotP3);
  assert('Client-B received pump1=MANUAL_ON via socket',  bGotP1);
  assert('Client-B received pump2=AUTO via socket',        bGotP2);
  assert('Client-B received pump3=AUTO via socket',        bGotP3);

  const clientC = createSocketClient('Client-C', C.green);
  await wait(1500);

  assert(
    'Client-C (late joiner) received pump_state_sync',
    clientC.received.pumpStateSync !== null,
  );
  assert(
    'Client-C sees pump1=MANUAL_ON (updated state)',
    clientC.received.pumpStateSync?.pump1 === 'MANUAL_ON',
  );
  assert(
    'Client-C sees pump2=AUTO (updated state)',
    clientC.received.pumpStateSync?.pump2 === 'AUTO',
  );
  assert(
    'Client-C sees pump3=AUTO (updated state)',
    clientC.received.pumpStateSync?.pump3 === 'AUTO',
  );

  // ── Phase 4: rapid-fire commands — all clients keep up ───────────────────
  console.log(c(C.bold, '\n── Phase 4: rapid-fire commands across all pumps ────────────\n'));

  const commandsBefore = clientA.received.pumpCommands.length;
  const rapidSequence = [
    ['/api/pump/command',  'MANUAL_OFF'],
    ['/api/pump/command2', 'MANUAL_OFF'],
    ['/api/pump/command3', 'MANUAL_OFF'],
    ['/api/pump/command',  'AUTO'],
    ['/api/pump/command2', 'MANUAL_ON'],
    ['/api/pump/command3', 'MANUAL_ON'],
  ];
  for (const [ep, cmd] of rapidSequence) {
    await httpCommand(ep, cmd);
    await wait(200);
  }
  await wait(800);

  const newCommands = clientA.received.pumpCommands.length - commandsBefore;
  assert(
    `Client-A received all ${rapidSequence.length} rapid commands (got ${newCommands})`,
    newCommands >= rapidSequence.length,
  );

  // ── Restore baseline ──────────────────────────────────────────────────────
  console.log(c(C.dim, '\n  [test] Restoring baseline: pump1=AUTO pump2=MANUAL_OFF pump3=MANUAL_OFF'));
  await httpCommand('/api/pump/command',  'AUTO');       await wait(300);
  await httpCommand('/api/pump/command2', 'MANUAL_OFF'); await wait(300);
  await httpCommand('/api/pump/command3', 'MANUAL_OFF'); await wait(300);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(c(C.bold, '\n══════════════════════════════════════════'));
  const total = passed + failed;
  if (failed === 0) {
    console.log(c(C.green + C.bold, `  ALL ${total} TESTS PASSED ✓`));
  } else {
    console.log(c(C.red + C.bold,   `  ${failed}/${total} TESTS FAILED ✗`));
  }
  console.log(c(C.bold, '══════════════════════════════════════════\n'));

  clientA.socket.disconnect();
  clientB.socket.disconnect();
  clientC.socket.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error(c(C.red, `[pump-sync-test] Fatal: ${err.message}`));
  process.exit(1);
});
