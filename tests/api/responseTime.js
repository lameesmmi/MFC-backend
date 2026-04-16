'use strict';

/**
 * Response-Time Benchmark — Integrated Specification 6
 * ─────────────────────────────────────────────────────
 * Verifies that all backend API endpoints respond within ≤ 5 seconds.
 *
 * Prerequisites:
 *   1. Backend is running  (npm start / node server.js)
 *   2. Set environment variables:
 *        BACKEND_URL=http://localhost:5000   (or your deployed URL)
 *        TEST_TOKEN=<valid JWT from /api/auth/login>
 *
 * Run:
 *   BACKEND_URL=http://localhost:5000 TEST_TOKEN=<token> node tests/api/responseTime.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const http  = require('http');
const https = require('https');

const BASE  = (process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
const TOKEN = process.env.TEST_TOKEN || '';
const LIMIT_MS = 5000;   // Integrated Specification 6: ≤ 5 s per endpoint

if (!TOKEN) {
  console.error('ERROR: TEST_TOKEN env var is required.');
  console.error('  Get it by calling POST /api/auth/login and copying the token field.');
  process.exit(1);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url    = new URL(BASE + path);
    const lib    = url.protocol === 'https:' ? https : http;
    const data   = body ? JSON.stringify(body) : undefined;
    const opts   = {
      hostname : url.hostname,
      port     : url.port || (url.protocol === 'https:' ? 443 : 80),
      path     : url.pathname + url.search,
      method,
      headers  : {
        'Authorization' : `Bearer ${TOKEN}`,
        'Content-Type'  : 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };

    const start = Date.now();
    const req   = lib.request(opts, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - start, body: raw }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── test cases ──────────────────────────────────────────────────────────────

const CASES = [
  { label: 'GET /api/health          (no auth)',        method: 'GET',  path: '/api/health',                  noToken: true },
  { label: 'GET /api/readings        (last 100)',        method: 'GET',  path: '/api/readings?limit=100' },
  { label: 'GET /api/alerts          (first page)',      method: 'GET',  path: '/api/alerts?page=1&limit=20' },
  { label: 'GET /api/analytics       (24h range)',       method: 'GET',  path: '/api/analytics?range=24h' },
  { label: 'GET /api/analytics       (7d range)',        method: 'GET',  path: '/api/analytics?range=7d' },
  { label: 'GET /api/settings        (current config)',  method: 'GET',  path: '/api/settings' },
  { label: 'GET /api/export/readings (24h CSV)',         method: 'GET',  path: '/api/export/readings?range=24h' },
];

// ─── runner ──────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n=== Integrated Specification 6 — API Response Time Benchmark ===');
  console.log(`    Threshold: ≤ ${LIMIT_MS} ms per endpoint`);
  console.log(`    Target:    ${BASE}\n`);

  let passed = 0;
  let failed = 0;

  for (const tc of CASES) {
    try {
      const res = await request(tc.method, tc.path);
      const ok  = res.ms <= LIMIT_MS;
      const tag = ok ? 'PASS' : 'FAIL';
      console.log(`  [${tag}]  ${tc.label}`);
      console.log(`          HTTP ${res.status}  |  ${res.ms} ms  (limit: ${LIMIT_MS} ms)`);
      ok ? passed++ : failed++;
    } catch (err) {
      console.log(`  [ERR ]  ${tc.label}`);
      console.log(`          ${err.message}`);
      failed++;
    }
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed out of ${CASES.length} endpoints`);

  if (failed > 0) {
    console.log('\n  OVERALL: FAIL — one or more endpoints exceeded the 5-second limit.\n');
    process.exit(1);
  } else {
    console.log('\n  OVERALL: PASS — all endpoints respond within 5 seconds.\n');
  }
}

run().catch(err => { console.error(err); process.exit(1); });
