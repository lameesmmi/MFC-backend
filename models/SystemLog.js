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
    ph: { type: Number, required: true },
    tds: { type: Number, required: true },
    temperature: { type: Number, required: true },
    flow_rate: { type: Number, required: true },
    salinity: { type: Number, required: true },
    conductivity: { type: Number, required: true },
    
    // Electrical Output Metrics
    current: { type: Number, required: true },
    voltage: { type: Number, required: true },
    power: { type: Number, required: true }
  },
  valve_status: { 
    type: String, 
    enum: ['OPEN', 'CLOSED'], 
    required: true 
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