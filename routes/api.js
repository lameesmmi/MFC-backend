'use strict';

const express = require('express');
const router = express.Router();
const SystemLog = require('../models/SystemLog');
const Alert = require('../models/Alert');
const Settings = require('../models/Settings');
const { formatAlert } = require('../services/alertService');
const { invalidateCache, DEFAULTS } = require('../services/settingsService');

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
    let since, until, range, timeFmt, bucketDurationHrs;

    if (req.query.from && req.query.to) {
      const fromDate = new Date(req.query.from);
      const toDate   = new Date(req.query.to);
      if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        return res.status(400).json({ error: 'Invalid date format for from/to' });
      }
      since = fromDate;
      until = toDate;
      until.setHours(23, 59, 59, 999);
      range = 'custom';
      const rangeDays     = (until - since) / 86_400_000;
      timeFmt             = rangeDays <= 2 ? '%Y-%m-%dT%H:00' : '%Y-%m-%d';
      bucketDurationHrs   = rangeDays <= 2 ? 1 : 24;
    } else {
      range               = RANGE_MS[req.query.range] ? req.query.range : '24h';
      since               = new Date(Date.now() - RANGE_MS[range]);
      until               = new Date();
      timeFmt             = range === '24h' ? '%Y-%m-%dT%H:00' : '%Y-%m-%d';
      bucketDurationHrs   = range === '24h' ? 1 : 24;
    }

    const tsFilter = { $gte: since, $lte: until };

    const [buckets, [summary], failedParams, alertsBySensor, alertsBySeverity, [resolutionStats]] =
      await Promise.all([

        // ── Time-bucketed sensor averages + EOR pass/fail counts ──────────────
        SystemLog.aggregate([
          { $match: { timestamp: tsFilter } },
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
          { $match: { timestamp: tsFilter } },
          { $group: {
            _id:           null,
            totalReadings: { $sum: 1 },
            passCount:     { $sum: { $cond: [{ $eq: ['$validation.status', 'PASS'] }, 1, 0] } },
            avgPower:      { $avg: '$readings.power' },
          }},
        ]),

        // ── Failure counts per sensor (from failed_parameters array) ──────────
        SystemLog.aggregate([
          { $match: { timestamp: tsFilter, 'validation.failed_parameters.0': { $exists: true } } },
          { $unwind: '$validation.failed_parameters' },
          { $group: { _id: '$validation.failed_parameters', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),

        // ── Alert count grouped by sensor ─────────────────────────────────────
        Alert.aggregate([
          { $match: { timestamp: tsFilter } },
          { $group: { _id: '$sensor', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),

        // ── Alert count grouped by severity ───────────────────────────────────
        Alert.aggregate([
          { $match: { timestamp: tsFilter } },
          { $group: { _id: '$severity', count: { $sum: 1 } } },
        ]),

        // ── Average resolution time for resolved alerts ───────────────────────
        Alert.aggregate([
          { $match: { timestamp: tsFilter, status: 'resolved', resolvedAt: { $exists: true } } },
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

// ─── Settings ─────────────────────────────────────────────────────────────────

/**
 * GET /api/settings
 * Returns the current system settings (creates defaults if none exist).
 */
router.get('/settings', async (req, res) => {
  try {
    let doc = await Settings.findOne().lean();
    if (!doc) {
      const created = await Settings.create({});
      doc = created.toObject();
    }
    res.json(formatSettings(doc));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/settings
 * Validates and persists updated settings, then broadcasts to all clients.
 *
 * Body: { thresholds?: { [sensor]: { min, max, severity? } }, alertsEnabled?: boolean }
 */
router.put('/settings', async (req, res) => {
  try {
    const { thresholds, alertsEnabled } = req.body;
    const update = {};

    if (thresholds && typeof thresholds === 'object') {
      for (const [key, val] of Object.entries(thresholds)) {
        if (typeof val.min !== 'number' || typeof val.max !== 'number') {
          return res.status(400).json({ error: `Invalid threshold values for "${key}"` });
        }
        if (val.min > val.max) {
          return res.status(400).json({ error: `min must be ≤ max for "${key}"` });
        }
        update[`thresholds.${key}.min`] = val.min;
        update[`thresholds.${key}.max`] = val.max;
        if (val.severity === 'warning' || val.severity === 'critical') {
          update[`thresholds.${key}.severity`] = val.severity;
        }
      }
    }

    if (typeof alertsEnabled === 'boolean') {
      update.alertsEnabled = alertsEnabled;
    }

    const doc = await Settings.findOneAndUpdate(
      {},
      { $set: update },
      { new: true, upsert: true }
    ).lean();

    invalidateCache();
    req.app.get('io').emit('settings_updated', formatSettings(doc));
    res.json(formatSettings(doc));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/settings/reset
 * Restores factory defaults and broadcasts to all clients.
 */
router.post('/settings/reset', async (req, res) => {
  try {
    const doc = await Settings.findOneAndUpdate(
      {},
      { $set: { thresholds: DEFAULTS.thresholds, alertsEnabled: DEFAULTS.alertsEnabled } },
      { new: true, upsert: true }
    ).lean();

    invalidateCache();
    req.app.get('io').emit('settings_updated', formatSettings(doc));
    res.json(formatSettings(doc));
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

/**
 * Strips internal Mongoose fields and normalises the settings document for the API.
 */
function formatSettings(doc) {
  return {
    thresholds:    doc.thresholds,
    alertsEnabled: doc.alertsEnabled,
    updatedAt:     doc.updatedAt ?? null,
  };
}

module.exports = router;
