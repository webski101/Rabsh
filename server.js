'use strict';
/**
 * RABSH server — node:http only.
 *   Serves ui/ and lib/{demand,score}.js (same math in browser and tests).
 *   /api/*        read-side, RO key only
 *   /api/execute  write-side, RW key only (executor module)
 *
 * Flags: --replay (serve everything from data/cache, zero network)
 * Env:   WHEELHOUSE_KEY_RO, WHEELHOUSE_KEY_RW (optional), PORT
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { createClient, REPLAY } = require('./lib/client');
const { createAudit } = require('./lib/audit');
const { verifyChain } = require('./lib/verify');
const { simulateAll } = require('./lib/simulate');
const { createExecutor } = require('./lib/executor');
const { validatePayload } = require('./lib/scenarios');

const PORT = Number(process.env.PORT) || 8787;
const RO_KEY = process.env.WHEELHOUSE_KEY_RO || '';
const RW_KEY = process.env.WHEELHOUSE_KEY_RW || '';

const audit = createAudit();
// The simulation side only ever receives the RO client — no put method exists.
const roClient = createClient({ apiKey: RO_KEY, allowWrite: false });
const executor = createExecutor({ roKey: RO_KEY, rwKey: RW_KEY, audit });

// UI-originated decision events allowed into the audit chain.
const UI_EVENTS = new Set(['decision.selected', 'decision.score_summary']);

// ---------- helpers ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function serveStatic(res, filePath) {
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'Not found' });
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- data assembly ----------

async function fetchBundle(listingId, channel) {
  const q = `?channel=${encodeURIComponent(channel)}`;
  const bundle = { listing_id: listingId, channel };

  const baseline = await roClient.get(
    `/listings/${listingId}/price_recommendations${q}&attribution=true`
  );
  bundle.baseline = baseline.data;
  audit.append('sim.baseline_fetched', {
    listing_id: listingId,
    days: Array.isArray(baseline.data?.data) ? baseline.data.data.length : null,
  });

  // Calibration inputs — each optional; a failure degrades, not aborts.
  for (const [name, p] of [
    ['kpis', `/listings/${listingId}/kpis${q}`],
    ['seasonality', `/listings/${listingId}/monthly_seasonality${q}`],
    ['min_max', `/listings/${listingId}/min_max_prices${q}`],
  ]) {
    try {
      bundle[name] = (await roClient.get(p)).data;
    } catch (err) {
      bundle[name] = null;
      bundle[name + '_error'] = err.message;
    }
  }
  return bundle;
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/status') {
    return sendJson(res, 200, {
      replay: REPLAY,
      has_ro_key: Boolean(RO_KEY),
      executor_mode: executor.mode, // 'rw' | 'ro' | 'replay'
      audit_entries: audit.tail(1).length ? audit.tail(1)[0].seq + 1 : 0,
    });
  }

  if (req.method === 'GET' && p === '/api/listings') {
    const r = await roClient.get('/listings');
    return sendJson(res, 200, r.data);
  }

  if (req.method === 'POST' && p === '/api/simulate') {
    const body = await readBody(req);
    const { listing_id, channel } = body;
    if (!listing_id || !channel) return sendJson(res, 400, { error: 'listing_id and channel required' });

    audit.append('sim.run_started', { listing_id, channel, replay: REPLAY });
    const bundle = await fetchBundle(listing_id, channel);

    let extra = null;
    if (body.custom_payload && Object.keys(body.custom_payload).length) {
      validatePayload(body.custom_payload);
      extra = { payload: body.custom_payload };
    }
    const sim = await simulateAll(roClient, { id: listing_id, channel }, audit, extra);
    audit.append('sim.run_finished', {
      listing_id,
      scenarios: sim.previews.length,
      failed: sim.previews.filter((x) => x.error).length,
      calibration_ok: sim.calibration.ok,
    });
    return sendJson(res, 200, { ...bundle, ...sim, replay: REPLAY });
  }

  if (req.method === 'POST' && p === '/api/simulate/custom') {
    // Custom composer: a single extra preview without re-running the fan-out.
    const body = await readBody(req);
    const { listing_id, channel, payload } = body;
    if (!listing_id || !channel || !payload) return sendJson(res, 400, { error: 'listing_id, channel, payload required' });
    validatePayload(payload);
    const { normalizeDays, previewPath } = require('./lib/simulate');
    try {
      const r = await roClient.post(previewPath(listing_id, channel), payload);
      audit.append('sim.preview', { scenario: 'custom', status: r.status, payload });
      return sendJson(res, 200, { days: normalizeDays(r.data), status: r.status });
    } catch (err) {
      audit.append('sim.preview_failed', { scenario: 'custom', error: err.message });
      return sendJson(res, err.status && err.status >= 400 ? 422 : 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && p === '/api/execute/plan') {
    const body = await readBody(req);
    const { listing_id, channel, payload, scenario_id } = body;
    if (!listing_id || !channel || !payload) return sendJson(res, 400, { error: 'listing_id, channel, payload required' });
    const planObj = await executor.plan(listing_id, channel, payload, scenario_id);
    // Never leak more than needed: current/proposed/diff is exactly what the
    // confirm screen shows.
    return sendJson(res, 200, {
      mode: planObj.mode,
      diff: planObj.diff,
      diff_hash: planObj.diff_hash,
      current: planObj.current,
      proposed: planObj.proposed,
      put_body: planObj.put_body,
    });
  }

  if (req.method === 'POST' && p === '/api/execute/apply') {
    const body = await readBody(req);
    if (!body.diff_hash) return sendJson(res, 400, { error: 'diff_hash required (run plan first)' });
    const result = await executor.apply(body.diff_hash);
    return sendJson(res, 200, result);
  }

  if (req.method === 'GET' && p === '/api/audit') {
    return sendJson(res, 200, { entries: audit.tail(100), log_path: audit.logPath });
  }

  if (req.method === 'GET' && p === '/api/audit/verify') {
    const result = verifyChain(audit.logPath);
    audit.append('audit.verified', { ok: result.ok, entries: result.entries });
    return sendJson(res, 200, result);
  }

  if (req.method === 'POST' && p === '/api/audit/event') {
    const body = await readBody(req);
    if (!UI_EVENTS.has(body.event)) return sendJson(res, 400, { error: 'Unknown event type' });
    const entry = audit.append(body.event, body.payload ?? null);
    return sendJson(res, 200, { seq: entry.seq, hash: entry.hash });
  }

  return sendJson(res, 404, { error: 'Unknown API route' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    // Static: UI + the two shared math modules.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveStatic(res, path.join(__dirname, 'ui', 'index.html'));
    }
    if (url.pathname === '/tokens.css') {
      return serveStatic(res, path.join(__dirname, 'tokens.css'));
    }
    if (url.pathname === '/lib/demand.js' || url.pathname === '/lib/score.js') {
      return serveStatic(res, path.join(__dirname, url.pathname));
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? 502 : 500;
    sendJson(res, status, { error: err.message, api_status: err.status ?? null });
  }
});

server.listen(PORT, () => {
  console.log(`RABSH listening on http://localhost:${PORT}`);
  console.log(`  mode:     ${REPLAY ? 'REPLAY (zero network)' : 'LIVE'}`);
  console.log(`  RO key:   ${RO_KEY ? 'present' : 'MISSING — live reads will fail'}`);
  console.log(`  executor: ${executor.mode}`);
});
