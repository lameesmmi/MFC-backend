'use strict';

const mongoose = require('mongoose');

const SystemLogSchema = new mongoose.Schema({
  timestamp: { 
    type: Date, 
    required: true 
  },
  metadata: {
    device_id: { type: String, required: true, default: 'MFC_01' },
    location: { type: String, required: true, default: 'Dammam_Lab' }
  },
  readings: {
    // Water Quality Metrics
    ph:          { type: Number },
    tds:         { type: Number },
    temperature: { type: Number },
    flow_rate:   { type: Number },
    salinity:    { type: Number },
    conductivity:{ type: Number },

    // Electrical Output Metrics
    current: { type: Number },
    voltage: { type: Number },
    power:   { type: Number }
  },
  valve_status: {
    type: String,
    enum: ['OPEN', 'CLOSED'],
  },
  validation: {
    status: { type: String, enum: ['PASS', 'FAIL'], required: true },
    failed_parameters: [{ type: String }] // Array to list exactly which sensors failed
  }
}, { 
  
  timeseries: {
    timeField: 'timestamp',
    metaField: 'metadata',
    granularity: 'seconds'
  }
});

module.exports = mongoose.model('SystemLog', SystemLogSchema);