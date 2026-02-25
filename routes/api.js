'use strict';

const express = require('express');
const router = express.Router();
const SystemLog = require('../models/SystemLog');
const Alert = require('../models/Alert');
const { formatAlert } = require('../services/alertService');

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

// ─── Analytics ───────────────────────────────────────────────────────────────

const RANGE_MS = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };

/**
 * GET /api/analytics?range=24h|7d|30d
 * Returns pre-aggregated analytics derived from SystemLog and Alert collections.
 */
router.get('/analytics', async (req, res) => {
  try {
    const range   = RANGE_MS[req.query.range] ? req.query.range : '24h';
    const rangeMs = RANGE_MS[range];
    const since   = new Date(Date.now() - rangeMs);

    // Hourly buckets for 24h, daily buckets for 7d/30d
    const timeFmt            = range === '24h' ? '%Y-%m-%dT%H:00' : '%Y-%m-%d';
    const bucketDurationHrs  = range === '24h' ? 1 : 24;

    const [buckets, [summary], failedParams, alertsBySensor, alertsBySeverity, [resolutionStats]] =
      await Promise.all([

        // ── Time-bucketed sensor averages + EOR pass/fail counts ──────────────
        SystemLog.aggregate([
          { $match: { timestamp: { $gte: since } } },
          { $group: {
            _id:        { $dateToString: { format: timeFmt, date: '$timestamp' } },
            avgPower:   { $avg: '$readings.power'       },
            avgPh:      { $avg: '$readings.ph'          },
            avgTds:     { $avg: '$readings.tds'         },
            avgTemp:    { $avg: '$readings.temperature' },
            passCount:  { $sum: { $cond: [{ $eq: ['$validation.status', 'PASS'] }, 1, 0] } },
            failCount:  { $sum: { $cond: [{ $eq: ['$validation.status', 'FAIL'] }, 1, 0] } },
            count:      { $sum: 1 },
          }},
          { $sort: { _id: 1 } },
        ]),

        // ── Overall summary for the period ────────────────────────────────────
        SystemLog.aggregate([
          { $match: { timestamp: { $gte: since } } },
          { $group: {
            _id:           null,
            totalReadings: { $sum: 1 },
            passCount:     { $sum: { $cond: [{ $eq: ['$validation.status', 'PASS'] }, 1, 0] } },
            avgPower:      { $avg: '$readings.power' },
          }},
        ]),

        // ── Failure counts per sensor (from failed_parameters array) ──────────
        SystemLog.aggregate([
          { $match: { timestamp: { $gte: since }, 'validation.failed_parameters.0': { $exists: true } } },
          { $unwind: '$validation.failed_parameters' },
          { $group: { _id: '$validation.failed_parameters', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),

        // ── Alert count grouped by sensor ─────────────────────────────────────
        Alert.aggregate([
          { $match: { timestamp: { $gte: since } } },
          { $group: { _id: '$sensor', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),

        // ── Alert count grouped by severity ───────────────────────────────────
        Alert.aggregate([
          { $match: { timestamp: { $gte: since } } },
          { $group: { _id: '$severity', count: { $sum: 1 } } },
        ]),

        // ── Average resolution time for resolved alerts ───────────────────────
        Alert.aggregate([
          { $match: { timestamp: { $gte: since }, status: 'resolved', resolvedAt: { $exists: true } } },
          { $group: {
            _id:             null,
            avgResolutionMs: { $avg: { $subtract: ['$resolvedAt', '$timestamp'] } },
            resolvedCount:   { $sum: 1 },
          }},
        ]),
      ]);

    // Energy = sum of (avgPower_per_bucket × bucket duration in hours)
    const totalEnergyWh = buckets.reduce((s, b) => s + (b.avgPower || 0) * bucketDurationHrs, 0);
    const stats = summary ?? { totalReadings: 0, passCount: 0, avgPower: 0 };

    res.json({
      range,
      summary: {
        totalReadings: stats.totalReadings,
        eorPassRate:   stats.totalReadings > 0 ? +((stats.passCount / stats.totalReadings) * 100).toFixed(1) : null,
        totalEnergyWh: +totalEnergyWh.toFixed(3),
        avgPowerW:     +(stats.avgPower || 0).toFixed(3),
      },
      powerOverTime: buckets.map(b => ({
        time:     b._id,
        avgPower: +(b.avgPower || 0).toFixed(3),
        energyWh: +((b.avgPower || 0) * bucketDurationHrs).toFixed(3),
      })),
      eorOverTime: buckets.map(b => ({
        time: b._id,
        pass: b.passCount,
        fail: b.failCount,
      })),
      sensorTrends: buckets.map(b => ({
        time:        b._id,
        ph:          +(b.avgPh   || 0).toFixed(2),
        tds:         +(b.avgTds  || 0).toFixed(0),
        temperature: +(b.avgTemp || 0).toFixed(1),
      })),
      failuresBySensor: failedParams.map(f => ({ sensor: f._id, count: f.count })),
      alertStats: {
        bySensor:        alertsBySensor.map(a  => ({ sensor:   a._id, count: a.count })),
        bySeverity:      alertsBySeverity.map(a => ({ severity: a._id, count: a.count })),
        avgResolutionMs: resolutionStats?.avgResolutionMs ?? null,
        resolvedCount:   resolutionStats?.resolvedCount   ?? 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Alerts ───────────────────────────────────────────────────────────────────

/**
 * GET /api/alerts?status=active&limit=100
 * Returns alerts newest-first. Optionally filter by status.
 */
router.get('/alerts', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const query = req.query.status ? { status: req.query.status } : {};

    const docs = await Alert.find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    res.json(docs.map(formatAlert));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/alerts/:id/acknowledge
 */
router.patch('/alerts/:id/acknowledge', async (req, res) => {
  try {
    const doc = await Alert.findOneAndUpdate(
      { _id: req.params.id, status: 'active' },
      { status: 'acknowledged' },
      { new: true }
    ).lean();
    if (!doc) return res.status(404).json({ error: 'Active alert not found' });
    res.json(formatAlert(doc));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/alerts/:id/resolve
 */
router.patch('/alerts/:id/resolve', async (req, res) => {
  try {
    const doc = await Alert.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ['active', 'acknowledged'] } },
      { status: 'resolved', resolvedAt: new Date() },
      { new: true }
    ).lean();
    if (!doc) return res.status(404).json({ error: 'Unresolved alert not found' });
    res.json(formatAlert(doc));
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
