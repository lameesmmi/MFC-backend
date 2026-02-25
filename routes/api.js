'use strict';

const express = require('express');
const router = express.Router();
const SystemLog = require('../models/SystemLog');

// ─── Health ──────────────────────────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({ status: 'Backend is running', time: new Date() });
});

// ─── Sensor Readings ─────────────────────────────────────────────────────────

/**
 * GET /api/readings?limit=100
 * Returns the last N sensor readings from MongoDB, newest-last.
 * Fields are normalized to camelCase for the frontend.
 */
router.get('/readings', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);

    const docs = await SystemLog.find()
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    const data = docs.reverse().map(formatReading);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalizes a raw SystemLog document into the shape the frontend expects.
 * Converts snake_case DB fields to camelCase and flattens nested objects.
 *
 * @param {object} doc - Lean Mongoose document
 */
function formatReading(doc) {
  return {
    timestamp:        doc.timestamp.toISOString(),
    time:             new Date(doc.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    ph:               doc.readings.ph,
    flowRate:         doc.readings.flow_rate,
    tds:              doc.readings.tds,
    salinity:         doc.readings.salinity,
    conductivity:     doc.readings.conductivity,
    temperature:      doc.readings.temperature,
    voltage:          doc.readings.voltage,
    current:          doc.readings.current,
    power:            doc.readings.power,
    valveStatus:      doc.valve_status,
    validationStatus: doc.validation?.status,
  };
}

module.exports = router;
