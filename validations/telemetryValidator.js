'use strict';

const MAX_LATENCY_MS = 5000;

function validateTelemetry(rawPayload) {
  // 1. Basic Object Integrity Check
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return { valid: false, reason: 'Payload is not a JSON object' };
  }

  // 2. Only timestamp is strictly required; all sensor fields (including valve_status) are optional
  if (!('timestamp' in rawPayload)) {
    return { valid: false, reason: 'Missing required field: timestamp' };
  }

  const { timestamp, ph, tds, temperature, flow_rate, salinity, conductivity, current, voltage, power, valve_status } = rawPayload;

  // 3. Hard Gatekeeper: Physics Bounds & Data Types (only for fields that are present)
  if (ph !== undefined && ph !== null) {
    if (typeof ph !== 'number' || !Number.isFinite(ph) || ph < 0 || ph > 14) {
      return { valid: false, reason: 'ph must be a finite number between 0 and 14' };
    }
  }
  if (tds !== undefined && tds !== null) {
    if (typeof tds !== 'number' || tds < 0) return { valid: false, reason: 'tds must be >= 0' };
  }
  if (temperature !== undefined && temperature !== null) {
    if (typeof temperature !== 'number' || temperature < 0) return { valid: false, reason: 'temperature must be >= 0' };
  }
  if (flow_rate !== undefined && flow_rate !== null) {
    if (typeof flow_rate !== 'number' || flow_rate < 0) return { valid: false, reason: 'flow_rate must be >= 0' };
  }
  if (salinity !== undefined && salinity !== null) {
    if (typeof salinity !== 'number' || salinity < 0) return { valid: false, reason: 'salinity must be >= 0' };
  }
  if (conductivity !== undefined && conductivity !== null) {
    if (typeof conductivity !== 'number' || conductivity < 0) return { valid: false, reason: 'conductivity must be >= 0' };
  }
  if (voltage !== undefined && voltage !== null) {
    if (typeof voltage !== 'number' || voltage < -50 || voltage > 50) return { valid: false, reason: 'voltage must be between -50 and 50' };
  }
  if (current !== undefined && current !== null) {
    if (typeof current !== 'number') return { valid: false, reason: 'current must be a valid number' };
  }
  if (power !== undefined && power !== null) {
    if (typeof power !== 'number') return { valid: false, reason: 'power must be a valid number' };
  }

  if (valve_status !== undefined && valve_status !== null) {
    if (valve_status !== 'OPEN' && valve_status !== 'CLOSED') {
      return { valid: false, reason: 'valve_status must be exactly OPEN or CLOSED' };
    }
  }

  // 4. Hard Gatekeeper: Latency Check
  const packetDate = new Date(timestamp);
  if (isNaN(packetDate.getTime())) {
    return { valid: false, reason: 'Invalid timestamp format' };
  }

  const now = Date.now();
  const latency = now - packetDate.getTime();
  
  if (latency > MAX_LATENCY_MS) return { valid: false, reason: 'Timestamp is too old (latency > 5s)' };
  if (latency < -MAX_LATENCY_MS) return { valid: false, reason: 'Timestamp is in the future' };

  // 5. Soft Gatekeeper: EOR Standards Compliance
  const failed_parameters = [];
  
  // EOR Rule: pH must be 6.5 - 8.5 (only checked if sensor reported a value)
  if (ph !== undefined && ph !== null && (ph < 6.5 || ph > 8.5)) {
    failed_parameters.push('ph');
  }
  // EOR Rule: TDS must be <= 5000 (only checked if sensor reported a value)
  if (tds !== undefined && tds !== null && tds > 5000) {
    failed_parameters.push('tds');
  }

  const status = failed_parameters.length > 0 ? 'FAIL' : 'PASS';

  // Attach the validation metadata to the payload
  const validatedPayload = { 
    ...rawPayload, 
    validation: { status, failed_parameters } 
  };

  return { valid: true, payload: validatedPayload, date: packetDate };
}

module.exports = { validateTelemetry, MAX_LATENCY_MS };