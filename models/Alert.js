'use strict';

const mongoose = require('mongoose');

const AlertSchema = new mongoose.Schema({
  severity:   { type: String, enum: ['critical', 'warning', 'info'], required: true },
  sensor:     { type: String, required: true }, // 'ph', 'tds', 'temperature', 'flow_rate', 'device'
  message:    { type: String, required: true },
  value:      { type: Number },                 // reading that triggered the alert
  threshold:  { type: String },                 // human-readable threshold description
  timestamp:  { type: Date, default: Date.now, required: true },
  status:     { type: String, enum: ['active', 'acknowledged', 'resolved'], default: 'active' },
  resolvedAt: { type: Date },
});

AlertSchema.index({ status: 1, timestamp: -1 });
AlertSchema.index({ sensor: 1, status: 1 });

module.exports = mongoose.model('Alert', AlertSchema);
