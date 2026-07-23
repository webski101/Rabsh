'use strict';
/**
 * Rate-limited Wheelhouse RM API client. Zero dependencies.
 *
 * - Global token spacing: 60 req/min -> one request every ~1.1s, shared across
 *   every client instance in the process (single limiter, module-level).
 * - 429: exponential backoff with jitter. 423 (recs still generating): wait and
 *   retry. 409: single retry. 2xx (incl. 201 from preview) is success.
 * - Every response is cached to data/cache/<key>.json. `--replay` (or
 *   RABSH_REPLAY=1) serves everything from cache with zero network calls.
 * - Privilege separation: createClient({ allowWrite: false }) is physically
 *   incapable of PUT — the method throws before any network code runs.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BASE_URL = 'https://api.usewheelhouse.com/ss_api/v1';
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const MIN_INTERVAL_MS = 1100; // 60/min with headroom

const REPLAY =
  process.argv.includes('--replay') || process.env.RABSH_REPLAY === '1';

// ---------- helpers ----------

/** Deterministic JSON stringify (sorted keys) so cache keys are stable. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') +
    '}'
  );
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Cache key ignores the API key — replay must work regardless of env. */
function cacheKey(method, urlPath, body) {
  const raw = method + ' ' + urlPath + ' ' + (body ? stableStringify(body) : '');
  return sha256(raw).slice(0, 32);
}

function cachePath(key) {
  return path.join(CACHE_DIR, key + '.json');
}

function readCache(key) {
  const p = cachePath(key);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(key, entry) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(key), JSON.stringify(entry, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- global rate limiter (shared by all clients) ----------

let queueTail = Promise.resolve();
let lastRequestAt = 0;

function scheduleSlot() {
  const slot = queueTail.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  // Keep the chain alive even if a caller's request later fails.
  queueTail = slot.catch(() => {});
  return slot;
}

// ---------- core request ----------

class ApiError extends Error {
  constructor(status, urlPath, body) {
    const summary =
      typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
    super(`Wheelhouse API ${status} on ${urlPath}: ${summary}`);
    this.name = 'ApiError';
    this.status = status;
    this.urlPath = urlPath;
    this.body = body;
  }
}

async function liveRequest(method, urlPath, apiKey, body) {
  const maxAttempts = 6;
  let attempt = 0;
  let conflictRetried = false;

  for (;;) {
    attempt += 1;
    await scheduleSlot();
    const res = await fetch(BASE_URL + urlPath, {
      method,
      headers: {
        'X-Integration-Api-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (res.status >= 200 && res.status < 300) {
      return { status: res.status, data };
    }
    if (res.status === 429 && attempt < maxAttempts) {
      const backoff = Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;
      await sleep(backoff);
      continue;
    }
    if (res.status === 423 && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get('retry-after')) || 5;
      await sleep(retryAfter * 1000);
      continue;
    }
    if (res.status === 409 && !conflictRetried) {
      conflictRetried = true;
      await sleep(1500);
      continue;
    }
    throw new ApiError(res.status, urlPath, data);
  }
}

// ---------- client factory ----------

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {boolean} [opts.allowWrite=false] must be true for PUT to exist at all
 */
function createClient({ apiKey, allowWrite = false } = {}) {
  async function request(method, urlPath, body) {
    const key = cacheKey(method, urlPath, body);

    if (REPLAY) {
      const cached = readCache(key);
      if (!cached) {
        throw new ApiError(
          0,
          urlPath,
          `REPLAY MODE: no cached response for ${method} ${urlPath}. ` +
            `Run the same flow live once (or "npm run fixture") to populate data/cache/.`
        );
      }
      return { status: cached.status, data: cached.data, cached: true };
    }

    if (!apiKey) {
      throw new ApiError(0, urlPath, 'No API key configured for this client.');
    }
    const result = await liveRequest(method, urlPath, apiKey, body);
    writeCache(key, {
      meta: { method, path: urlPath, ts: new Date().toISOString() },
      status: result.status,
      data: result.data,
    });
    return result;
  }

  const client = {
    get: (urlPath) => request('GET', urlPath),
    post: (urlPath, body) => request('POST', urlPath, body),
  };

  if (allowWrite) {
    client.put = (urlPath, body) => request('PUT', urlPath, body);
  }
  // No `else` stub: a read-only client simply has no put method. The
  // simulation engine can never write, even by bug.

  return client;
}

module.exports = {
  createClient,
  cacheKey,
  writeCache,
  stableStringify,
  sha256,
  ApiError,
  REPLAY,
  BASE_URL,
  CACHE_DIR,
};
