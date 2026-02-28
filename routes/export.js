'use strict';

const router        = require('express').Router();
const SystemLog     = require('../models/SystemLog');
const { buildCsv }  = require('../services/csvFormatter');
const { requireRole } = require('../middleware/auth');

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ROWS = 10_000;

const RANGE_MS = {
  '24h': 1  * 24 * 60 * 60 * 1000,
  '7d':  7  * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// ─── GET /api/export/readings ─────────────────────────────────────────────────
//
// Exports SystemLog documents for a given date range as a CSV file download.
// Accessible by all authenticated roles (admin, operator, viewer).
//
// Query params (mirrors /api/analytics):
//   range  – '24h' | '7d' | '30d'  (default: '24h' when omitted)
//   from   – ISO date string (must be paired with 'to')
//   to     – ISO date string (must be paired with 'from')
//
// Responds with:
//   Content-Type: text/csv; charset=utf-8
//   Content-Disposition: attachment; filename="mfc-readings-<label>.csv"
//
// Errors:
//   400 – invalid date strings in from/to
//   400 – result set exceeds MAX_ROWS (10,000 rows)
//   401 – missing or invalid token
//   500 – unexpected server error

router.get('/readings', requireRole('admin', 'operator', 'viewer'), async (req, res) => {
  try {
    // ── Resolve date range ────────────────────────────────────────────────────

    let since, until, filenameLabel;

    if (req.query.from && req.query.to) {
      const fromDate = new Date(req.query.from);
      const toDate   = new Date(req.query.to);

      if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        return res.status(400).json({ error: 'Invalid date format for from/to. Use ISO 8601 strings.' });
      }

      since         = fromDate;
      until         = toDate;
      until.setHours(23, 59, 59, 999);
      filenameLabel = `${fmtDate(since)}_to_${fmtDate(until)}`;

    } else {
      const rangeKey = RANGE_MS[req.query.range] !== undefined ? req.query.range : '24h';
      since          = new Date(Date.now() - RANGE_MS[rangeKey]);
      until          = new Date();
      filenameLabel  = rangeKey;
    }

    const tsFilter = { $gte: since, $lte: until };

    // ── Guard: reject if result set exceeds the row limit ─────────────────────
    // countDocuments on a time-series collection is cheap — uses metadata.
    // This prevents large in-memory allocations and gives a descriptive error.

    const count = await SystemLog.countDocuments({ timestamp: tsFilter });

    if (count > MAX_ROWS) {
      return res.status(400).json({
        error: `The selected range contains ${count.toLocaleString()} readings, which exceeds the ${MAX_ROWS.toLocaleString()}-row export limit. Please narrow the date range.`,
      });
    }

    // ── Fetch documents in chronological order ────────────────────────────────
    // Oldest-first matches the natural reading order for a time-series CSV.

    const docs = await SystemLog
      .find({ timestamp: tsFilter })
      .sort({ timestamp: 1 })
      .lean();

    // ── Build CSV and stream response ─────────────────────────────────────────

    const csv      = buildCsv(docs);
    const filename = `mfc-readings-${filenameLabel}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Formats a Date as YYYY-MM-DD for use in download filenames. */
function fmtDate(date) {
  return date.toISOString().slice(0, 10);
}

module.exports = router;
