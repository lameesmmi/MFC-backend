'use strict';

/**
 * Test Suite — Telemetry Validator
 * ─────────────────────────────────
 * Unit tests for the validation gatekeeper (0 dependencies).
 * Run with: npm test validations/telemetryValidator.test.js
 */

const assert = require('assert');
const { validateTelemetry, MAX_LATENCY_MS } = require('../../validations/telemetryValidator');

// ─────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────

const getValidPayload = () => ({
  timestamp: new Date().toISOString(),
  ph: 7.1,
  tds: 1200,
  temperature: 25.4,
  flow_rate: 15.2,
  salinity: 8000,
  conductivity: 12.5,
  current: 2.1,
  voltage: 0.45,
  power: 0.94,
  valve_status: "OPEN"
});

// ─────────────────────────────────────────────────────────────────────────
// Test Cases
// ─────────────────────────────────────────────────────────────────────────

describe('validateTelemetry', () => {
  describe('1. Hard Gatekeeper: Integrity checks', () => {
    it('should reject non-object payloads', () => {
      const result = validateTelemetry(null);
      assert.strictEqual(result.valid, false);
      assert(result.reason.includes('not a JSON object'));
    });

    it('should reject arrays', () => {
      const result = validateTelemetry([1, 2, 3]);
      assert.strictEqual(result.valid, false);
    });

    it('should reject payload missing timestamp (only required field)', () => {
      const payload = getValidPayload();
      delete payload.timestamp;
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, false);
      assert(result.reason.includes('Missing required field: timestamp'));
    });

    it('should accept payload missing sensor readings (sensors may be offline)', () => {
      const payload = { timestamp: new Date().toISOString() };
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, true);
    });

    it('should accept payload missing valve_status', () => {
      const payload = getValidPayload();
      delete payload.valve_status;
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, true);
    });

    it('should accept partial payload with only some sensors present', () => {
      const payload = {
        timestamp: new Date().toISOString(),
        ph: 7.2,
        temperature: 24.0,
      };
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, true);
    });

    it('should reject invalid timestamp format', () => {
      const payload = getValidPayload();
      payload.timestamp = 'not-a-date';
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, false);
      assert(result.reason.includes('Invalid timestamp'));
    });
  });

  describe('2. Hard Gatekeeper: Physics bounds checks', () => {
    it('should reject pH outside 0-14', () => {
      const payload = getValidPayload();
      payload.ph = 15;
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, false);
    });

    it('should reject negative TDS', () => {
      const payload = getValidPayload();
      payload.tds = -10;
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, false);
    });

    it('should reject invalid valve_status', () => {
      const payload = getValidPayload();
      payload.valve_status = "HALF_OPEN"; // Must be strictly OPEN or CLOSED
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, false);
      assert(result.reason.includes('valve_status must be exactly OPEN or CLOSED'));
    });
  });

  describe('3. Hard Gatekeeper: Latency checks', () => {
    it('should reject packets older than 5 seconds', () => {
      const payload = getValidPayload();
      payload.timestamp = new Date(Date.now() - MAX_LATENCY_MS - 1000).toISOString();
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, false);
      assert(result.reason.includes('too old'));
    });

    it('should reject packets from the future', () => {
      const payload = getValidPayload();
      payload.timestamp = new Date(Date.now() + MAX_LATENCY_MS + 1000).toISOString();
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, false);
      assert(result.reason.includes('future'));
    });
  });

  describe('4. Soft Gatekeeper: EOR Standards Compliance', () => {
    it('should flag PASS if all EOR standards are met', () => {
      const result = validateTelemetry(getValidPayload());
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.payload.validation.status, 'PASS');
      assert.strictEqual(result.payload.validation.failed_parameters.length, 0);
    });

    it('should flag FAIL and list "ph" if pH is out of EOR range (6.5 - 8.5)', () => {
      const payload = getValidPayload();
      payload.ph = 6.0; // Still valid physics, but fails EOR
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.payload.validation.status, 'FAIL');
      assert(result.payload.validation.failed_parameters.includes('ph'), true);
    });

    it('should flag FAIL and list "tds" if TDS is > 5000', () => {
      const payload = getValidPayload();
      payload.tds = 6000;
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.payload.validation.status, 'FAIL');
      assert(result.payload.validation.failed_parameters.includes('tds'), true);
    });

    it('should flag FAIL and list multiple parameters if both fail', () => {
      const payload = getValidPayload();
      payload.ph = 9.0;
      payload.tds = 8000;
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.payload.validation.status, 'FAIL');
      assert(result.payload.validation.failed_parameters.includes('ph'), true);
      assert(result.payload.validation.failed_parameters.includes('tds'), true);
    });

    it('should PASS and not flag ph when ph is absent', () => {
      const payload = getValidPayload();
      delete payload.ph;
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.payload.validation.status, 'PASS');
      assert(!result.payload.validation.failed_parameters.includes('ph'));
    });

    it('should PASS and not flag tds when tds is absent', () => {
      const payload = getValidPayload();
      delete payload.tds;
      const result = validateTelemetry(payload);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.payload.validation.status, 'PASS');
      assert(!result.payload.validation.failed_parameters.includes('tds'));
    });
  });
});