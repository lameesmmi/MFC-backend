'use strict';

const { Schema, model } = require('mongoose');

// ─── Sub-schema ───────────────────────────────────────────────────────────────

const thresholdSchema = new Schema({
  min:      { type: Number, required: true },
  max:      { type: Number, required: true },
  severity: { type: String, enum: ['warning', 'critical'], default: 'warning' },
}, { _id: false });

// ─── Main schema ──────────────────────────────────────────────────────────────
// Only one document ever exists in this collection (singleton pattern).

const settingsSchema = new Schema({
  thresholds: {
    ph:          { type: thresholdSchema, default: () => ({ min: 6.5,  max: 8.5,   severity: 'warning'  }) },
    tds:         { type: thresholdSchema, default: () => ({ min: 0,    max: 5000,  severity: 'warning'  }) },
    temperature: { type: thresholdSchema, default: () => ({ min: 10,   max: 40,    severity: 'warning'  }) },
    flow_rate:   { type: thresholdSchema, default: () => ({ min: 0.5,  max: 10,    severity: 'warning'  }) },
    voltage:     { type: thresholdSchema, default: () => ({ min: 0,    max: 50,    severity: 'warning'  }) },
    current:     { type: thresholdSchema, default: () => ({ min: 0,    max: 5,     severity: 'warning'  }) },
  },
  alertsEnabled: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = model('Settings', settingsSchema);
