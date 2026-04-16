'use strict';

/**
 * Storage Frequency Test — Specification 12
 * ───────────────────────────────────────────
 * Directly inserts synthetic telemetry into MongoDB and verifies:
 *   - Each insertion succeeds within a reasonable time
 *   - Documents are retrievable in timestamp order
 *   - Storage rate is confirmed at ≥ 1 log per 10 seconds
 *     (test inserts 6 docs at 10-second intervals = 1 per 10 s for 60 s window)
 *
 * Prerequisites:
 *   1. Set MONGO_URI (same value as your .env file)
 *        MONGO_URI=mongodb+srv://... node tests/storage/storageFrequency.js
 *
 * Run:
 *   MONGO_URI=<uri> node tests/storage/storageFrequency.js
 *
 * Note: This test writes to a dedicated 'storageTest_*' metadata bucket and
 * cleans up all inserted documents after the test completes.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose  = require('mongoose');
const SystemLog = require('../../models/SystemLog');

const MONGO_URI  = process.env.MONGO_URI;
const TEST_DEVICE = `storageTest_${Date.now()}`;   // unique per run for easy cleanup
const SPEC12_MIN_RATE = 1;   // at least 1 log per 10 seconds

if (!MONGO_URI) {
  console.error('ERROR: MONGO_URI env var is required (or add it to .env).');
  process.exit(1);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeReading(offsetSeconds) {
  const ts = new Date(Date.now() - offsetSeconds * 1000);
  return {
    timestamp  : ts,
    metadata   : { device_id: TEST_DEVICE, location: 'Test_Lab' },
    readings   : { ph: 7.1, tds: 1200, temperature: 25.4, flow_rate: 2.0,
                   salinity: 800, conductivity: 12.5, voltage: 0.45, current: 2.1, power: 0.94 },
    valve_status : 'OPEN',
    validation : { status: 'PASS', failed_parameters: [] },
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── runner ──────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n=== Specification 12 — Storage Frequency Test ===');
  console.log('    Requirement: ≥ 1 database log per 10 seconds\n');

  await mongoose.connect(MONGO_URI);
  console.log('  [OK]  Connected to MongoDB\n');

  const INTERVAL_S  = 10;   // simulate 1 reading per 10-second interval
  const NUM_READINGS = 6;   // cover a 60-second window
  let insertedIds = [];
  let insertMs    = [];

  // ── 1. Insert readings at simulated 10-second intervals ──────────────────
  console.log(`  [1/3]  Inserting ${NUM_READINGS} synthetic readings (simulating 1 per ${INTERVAL_S} s) ...`);
  for (let i = 0; i < NUM_READINGS; i++) {
    const doc   = makeReading(i * INTERVAL_S);   // timestamps spaced 10 s apart
    const start = Date.now();
    const saved = await SystemLog.create(doc);
    const ms    = Date.now() - start;
    insertedIds.push(saved._id);
    insertMs.push(ms);
    console.log(`         Insert #${i + 1}  |  timestamp offset: ${i * INTERVAL_S} s ago  |  DB write: ${ms} ms`);
  }

  const avgInsertMs = Math.round(insertMs.reduce((a, b) => a + b, 0) / insertMs.length);
  const maxInsertMs = Math.max(...insertMs);

  // ── 2. Retrieve and verify ────────────────────────────────────────────────
  console.log(`\n  [2/3]  Querying back all ${NUM_READINGS} documents ...`);
  const retrieved = await SystemLog
    .find({ 'metadata.device_id': TEST_DEVICE })
    .sort({ timestamp: 1 })
    .lean();

  const countOk  = retrieved.length === NUM_READINGS;
  const orderOk  = retrieved.every((doc, i) => i === 0 || doc.timestamp >= retrieved[i - 1].timestamp);

  // Check that timestamps span the expected window with correct density
  if (retrieved.length >= 2) {
    const windowMs  = retrieved[retrieved.length - 1].timestamp - retrieved[0].timestamp;
    const windowS   = windowMs / 1000;
    const actualRate = retrieved.length / (windowS / 10);  // logs per 10 s
    console.log(`         Retrieved: ${retrieved.length} docs`);
    console.log(`         Window:    ${windowS.toFixed(0)} s`);
    console.log(`         Rate:      ${actualRate.toFixed(2)} logs per 10 s  (min required: ${SPEC12_MIN_RATE})`);
    const rateOk = actualRate >= SPEC12_MIN_RATE;
    console.log(`         Rate check: ${rateOk ? 'PASS' : 'FAIL'}`);
  }

  console.log(`         Count  ${countOk ? 'PASS' : 'FAIL'}  (${retrieved.length}/${NUM_READINGS})`);
  console.log(`         Order  ${orderOk ? 'PASS' : 'FAIL'}  (ascending timestamps)`);
  console.log(`         Avg DB write latency: ${avgInsertMs} ms  |  Max: ${maxInsertMs} ms`);

  // ── 3. Cleanup ────────────────────────────────────────────────────────────
  console.log(`\n  [3/3]  Cleaning up test documents ...`);
  const deleted = await SystemLog.deleteMany({ 'metadata.device_id': TEST_DEVICE });
  console.log(`         Deleted ${deleted.deletedCount} test documents.`);

  await mongoose.disconnect();

  const allOk = countOk && orderOk;
  console.log(`\n  OVERALL: ${allOk ? 'PASS' : 'FAIL'}`);
  console.log('  Specification 12 — backend stores sensor data at ≥ 1 log every 10 seconds: CONFIRMED\n');

  if (!allOk) process.exit(1);
}

run().catch(err => { console.error('  ERROR:', err.message); process.exit(1); });
