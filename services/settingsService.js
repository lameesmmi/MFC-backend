'use strict';

const Settings = require('../models/Settings');

// ─── Factory defaults ─────────────────────────────────────────────────────────
// Used as fallback when DB is not yet available (startup race condition).

const DEFAULTS = {
  thresholds: {
    ph:          { min: 6.5,  max: 8.5,   severity: 'warning' },
    tds:         { min: 0,    max: 5000,  severity: 'warning' },
    temperature: { min: 10,   max: 40,    severity: 'warning' },
    flow_rate:   { min: 0.5,  max: 10,    severity: 'warning' },
    voltage:     { min: 0,    max: 50,    severity: 'warning' },
    current:     { min: 0,    max: 5,     severity: 'warning' },
  },
  alertsEnabled: true,
};

// ─── In-memory cache ──────────────────────────────────────────────────────────
let _cache = null;

/**
 * Returns the current settings, loading from DB on first call.
 * Falls back to DEFAULTS if the DB is not yet available.
 */
async function getSettings() {
  if (_cache) return _cache;
  try {
    return await refreshSettings();
  } catch (err) {
    console.warn('[settingsService] DB not ready, using defaults:', err.message);
    return DEFAULTS;
  }
}

/**
 * Reloads settings from DB, creating the singleton document if absent.
 * Always updates the in-memory cache.
 */
async function refreshSettings() {
  let doc = await Settings.findOne().lean();
  if (!doc) {
    const created = await Settings.create({});
    doc = created.toObject();
  }
  _cache = doc;
  return _cache;
}

/**
 * Clears the in-memory cache so the next call to getSettings() re-reads from DB.
 * Called after a PUT /settings or POST /settings/reset.
 */
function invalidateCache() {
  _cache = null;
}

module.exports = { getSettings, refreshSettings, invalidateCache, DEFAULTS };
