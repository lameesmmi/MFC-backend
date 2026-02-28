'use strict';

// ─── Column definitions ───────────────────────────────────────────────────────
// Each entry defines one CSV column: a human-readable header and a pure
// extractor function that reads a single lean SystemLog document.
// Order here determines column order in the output file.

const COLUMNS = [
  { header: 'Timestamp (ISO)',    extract: d => d.timestamp instanceof Date ? d.timestamp.toISOString() : d.timestamp },
  { header: 'Device ID',         extract: d => d.metadata?.device_id },
  { header: 'Location',          extract: d => d.metadata?.location },
  { header: 'pH',                extract: d => d.readings?.ph },
  { header: 'TDS (ppm)',         extract: d => d.readings?.tds },
  { header: 'Temperature (°C)',  extract: d => d.readings?.temperature },
  { header: 'Flow Rate (L/min)', extract: d => d.readings?.flow_rate },
  { header: 'Salinity',          extract: d => d.readings?.salinity },
  { header: 'Conductivity',      extract: d => d.readings?.conductivity },
  { header: 'Voltage (V)',       extract: d => d.readings?.voltage },
  { header: 'Current (A)',       extract: d => d.readings?.current },
  { header: 'Power (W)',         extract: d => d.readings?.power },
  { header: 'Valve Status',      extract: d => d.valve_status },
  { header: 'Validation Status', extract: d => d.validation?.status },
  {
    header:  'Failed Parameters',
    // Semicolon-delimited so the list stays in one cell without triggering CSV quoting
    extract: d => (d.validation?.failed_parameters ?? []).join(';'),
  },
];

// ─── Cell escaping ────────────────────────────────────────────────────────────

/**
 * Escapes a single cell value for RFC 4180-compliant CSV output.
 *
 * - null / undefined  → empty string
 * - number            → up to 4 decimal places, trailing zeros stripped
 * - string with comma, double-quote, CR, or LF → wrapped in double-quotes;
 *                       internal double-quotes are doubled ("")
 * - other strings     → returned as-is
 *
 * @param {*} value
 * @returns {string}
 */
function escapeCell(value) {
  if (value === null || value === undefined) return '';

  if (typeof value === 'number') {
    // toFixed(4) then strip trailing zeros and any trailing decimal point
    return parseFloat(value.toFixed(4)).toString();
  }

  const str = String(value);

  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Converts an array of lean SystemLog documents into a complete CSV string.
 *
 * The first row is the header row. Subsequent rows are data rows, one per
 * document. Lines are separated by CRLF (\\r\\n) per RFC 4180, which ensures
 * correct behaviour when the file is opened in Excel on Windows.
 *
 * @param {object[]} docs - Plain JS objects from SystemLog.find().lean()
 * @returns {string}      - Complete CSV text ready to send as a response body
 */
function buildCsv(docs) {
  const headerRow = COLUMNS.map(col => escapeCell(col.header)).join(',');

  const dataRows = docs.map(doc =>
    COLUMNS.map(col => escapeCell(col.extract(doc))).join(',')
  );

  return [headerRow, ...dataRows].join('\r\n');
}

module.exports = { buildCsv };
