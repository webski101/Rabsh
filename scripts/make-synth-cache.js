'use strict';
/**
 * SYNTHETIC replay fixture generator — development/fallback only.
 *
 * Populates data/cache/ with clearly-synthetic Wheelhouse responses shaped
 * like the smoke-test facts (10 hypothetical SF sample listings, 546-day
 * horizon, rich KPIs, multiplier semantics for base_price_adjustment) so that
 * `npm run replay` demos the full loop with zero network and zero keys.
 *
 * Before the real demo, run `npm run record` with live keys — it overwrites
 * these entries with genuine API responses under the same cache keys.
 *
 * Every synthetic listing is named "SAMPLE ..." and the manifest below marks
 * the cache as synthetic so nobody mistakes it for recorded data.
 */

const fs = require('node:fs');
const path = require('node:path');
const { cacheKey, writeCache, CACHE_DIR } = require('../lib/client');
const { buildScenarios } = require('../lib/scenarios');

// Deterministic PRNG so the fixture is stable run-to-run.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HORIZON = 546;
const CHANNEL = 'hypothetical';
const START = new Date();
START.setUTCHours(0, 0, 0, 0);

const LISTINGS = [
  { id: 64473579, bedrooms: 1, baths: 1, base: 189, zip: '94114' },
  { id: 64473580, bedrooms: 2, baths: 1, base: 245, zip: '94114' },
  { id: 64473581, bedrooms: 2, baths: 2, base: 268, zip: '94130' },
  { id: 64473582, bedrooms: 3, baths: 2, base: 329, zip: '94114' },
  { id: 64473583, bedrooms: 4, baths: 3, base: 384, zip: '94130' },
  { id: 64473584, bedrooms: 6, baths: 4, base: 420, zip: '94114' }, // default demo target
  { id: 64473585, bedrooms: 5, baths: 3, base: 402, zip: '94114' },
  { id: 64473586, bedrooms: 7, baths: 5, base: 512, zip: '94130' },
  { id: 64473587, bedrooms: 3, baths: 1, base: 301, zip: '94114' },
  { id: 64473588, bedrooms: 1, baths: 1, base: 175, zip: '94130' },
];

// SF-ish seasonality: Sep/Oct peak, winter trough.
const SEASON = { 1: 0.82, 2: 0.86, 3: 0.94, 4: 1.0, 5: 1.05, 6: 1.1, 7: 1.12, 8: 1.1, 9: 1.2, 10: 1.15, 11: 0.95, 12: 0.85 };
const DOW = { 0: 0.96, 1: 0.92, 2: 0.92, 3: 0.94, 4: 1.0, 5: 1.14, 6: 1.18 }; // Sun..Sat

function dateAt(i) {
  const d = new Date(START.getTime() + i * 86400000);
  return d;
}
const iso = (d) => d.toISOString().slice(0, 10);

/** Baseline recommended nightly price for a listing on day offset i. */
function recPrice(listing, i, rand) {
  const d = dateAt(i);
  const season = SEASON[d.getUTCMonth() + 1];
  const dow = DOW[d.getUTCDay()];
  const noise = 0.97 + rand() * 0.06;
  return Math.round(listing.base * season * dow * noise);
}

/** Apply a preview payload's semantics to the baseline calendar. */
function applyPayload(listing, payload, rand) {
  const days = [];
  const anchors = anchorsFor(listing);
  for (let i = 0; i < HORIZON; i++) {
    const d = dateAt(i);
    let price = recPrice(listing, i, rand);

    // Resolve the effective base like the real API (verified 2026-07-23):
    // no payload -> current base; base_price -> that absolute value;
    // base_price_adjustment -> MULTIPLIER applied to the RECOMMENDED base
    // (1.1 = +10% of rec), NOT the current base.
    let effectiveBase = anchors.current;
    if (payload.base_price) effectiveBase = payload.base_price;
    if (payload.base_price_adjustment) effectiveBase = anchors.rec * payload.base_price_adjustment;
    price = price * (effectiveBase / anchors.rec);

    if (payload.seasonality_adjustment) {
      const season = SEASON[d.getUTCMonth() + 1];
      const t = payload.seasonality_adjustment.type;
      const amp = t === 'CON' ? 0.6 : t === 'AGG' ? 1.45 : 1.0;
      price = (price / season) * (1 + (season - 1) * amp);
    }
    if (payload.day_of_week) {
      const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const pctUp = payload.day_of_week[names[d.getUTCDay()]];
      if (pctUp) price = price * (1 + pctUp / 100);
    }
    if (payload.last_minute_discount && payload.last_minute_discount.active) {
      const rule = [...payload.last_minute_discount.rules]
        .sort((a, b) => a.days - b.days)
        .find((r) => i <= r.days);
      if (rule) price = price * (1 - rule.amount / 100);
    }
    if (payload.far_future_premium && payload.far_future_premium.active) {
      const rule = payload.far_future_premium.rules.find((r) => i >= r.days);
      if (rule) price = price * (1 + rule.amount / 100);
    }
    days.push({ stay_date: iso(d), price: Math.round(price), currency: 'USD', custom_type: null });
  }
  return days;
}

function anchorsFor(listing) {
  return {
    current: listing.base,
    rec: Math.round(listing.base * 1.06),
    con: Math.round(listing.base * 0.92),
    agg: Math.round(listing.base * 1.22),
  };
}

function previewResponse(listing, payload, rand) {
  const a = anchorsFor(listing);
  return {
    data: applyPayload(listing, payload, rand),
    base_price: a.current,
    base_price_recommended: a.rec,
    base_price_conservative: a.con,
    base_price_aggressive: a.agg,
  };
}

function put(method, urlPath, body, status, data) {
  writeCache(cacheKey(method, urlPath, body), {
    meta: { method, path: urlPath, ts: new Date().toISOString(), synthetic: true },
    status,
    data,
  });
}

// ---------- generate ----------

fs.mkdirSync(CACHE_DIR, { recursive: true });

// GET /listings
put('GET', '/listings', undefined, 200, {
  data: LISTINGS.map((l) => ({
    id: l.id,
    channel: CHANNEL,
    name: `SAMPLE ${l.bedrooms}BR ${l.baths}BA in San Francisco`,
    market_id: 1,
    market_name: 'San Francisco',
    zip: l.zip,
    bedrooms: l.bedrooms,
    bathrooms: l.baths,
    status: 'active',
  })),
});

for (const listing of LISTINGS) {
  const q = `?channel=${CHANNEL}`;
  const rand = mulberry32(listing.id); // same noise per listing across payloads

  // Baseline price_recommendations with attribution.
  const baseRand = mulberry32(listing.id);
  const recDays = [];
  for (let i = 0; i < HORIZON; i++) {
    const d = dateAt(i);
    const price = recPrice(listing, i, baseRand);
    const season = SEASON[d.getUTCMonth() + 1];
    const dow = DOW[d.getUTCDay()];
    recDays.push({
      stay_date: iso(d),
      price,
      currency: 'USD',
      attr_base_price: listing.base,
      attr_seasonality: Number((season - 1).toFixed(3)),
      attr_day_of_week: Number((dow - 1).toFixed(3)),
      attr_demand: Number(((price / (listing.base * season * dow)) - 1).toFixed(3)),
      attr_events: 0,
    });
  }
  put('GET', `/listings/${listing.id}/price_recommendations${q}&attribution=true`, undefined, 200, {
    data: recDays,
  });

  // KPIs — forward occupancy windows + neighborhood context (smoke: richly populated).
  put('GET', `/listings/${listing.id}/kpis${q}`, undefined, 200, {
    occupancy: { '0_7': 0.83, '0_30': 0.72, '0_60': 0.64, '0_90': 0.58, '0_365': 0.51 },
    occupancy_neighborhood: { '0_7': 0.79, '0_30': 0.69, '0_60': 0.61, '0_90': 0.56, '0_365': 0.5 },
    occupancy_neighborhood_ratio: 1.05,
    adr: { '0_30': Math.round(listing.base * 1.04) },
    revenue_neighborhood: { '0_30': Math.round(listing.base * 0.69 * 30) },
  });

  // Monthly seasonality factors.
  put('GET', `/listings/${listing.id}/monthly_seasonality${q}`, undefined, 200, {
    data: Object.entries(SEASON).map(([month, factor]) => ({ month: Number(month), factor })),
  });

  // min_max_prices: 0 rows (verified — no floors configured).
  put('GET', `/listings/${listing.id}/min_max_prices${q}`, undefined, 200, { data: [] });

  // Current preferences (read-merge-write source).
  put('GET', `/preferences/${listing.id}${q}`, undefined, 200, {
    id: listing.id * 10 + 1,
    listing_id: listing.id,
    base_price: listing.base,
    seasonality_adjustment: { type: 'REC', rules: [] },
    last_minute_discount: { active: false, rules: [] },
    far_future_premium: { active: false, rules: [] },
    day_of_week: {},
    occupancy_pacing: {},
    minimum_price_rules_v3: [],
    maximum_price_rules_v3: [],
    updated_at: new Date().toISOString(),
  });

  // Previews: hold course ({}), calibration probe, all named scenarios.
  const previewPathStr = `/preferences/${listing.id}/preview${q}`;
  put('POST', previewPathStr, {}, 201, previewResponse(listing, {}, mulberry32(listing.id)));
  put('POST', previewPathStr, { base_price_adjustment: 1.1 }, 201,
    previewResponse(listing, { base_price_adjustment: 1.1 }, mulberry32(listing.id)));

  for (const sc of buildScenarios(anchorsFor(listing))) {
    if (sc.id === 'hold_course') continue;
    put('POST', previewPathStr, sc.payload, 201,
      previewResponse(listing, sc.payload, mulberry32(listing.id)));
  }
}

fs.writeFileSync(
  path.join(CACHE_DIR, 'demo-manifest.json'),
  JSON.stringify(
    {
      synthetic: true,
      note: 'SYNTHETIC fixture from scripts/make-synth-cache.js — run `npm run record` with live keys before the demo to replace with real API responses.',
      generated_at: new Date().toISOString(),
      listings: LISTINGS.map((l) => l.id),
      default_listing: 64473584,
    },
    null,
    2
  )
);

console.log(`Synthetic cache written to ${CACHE_DIR}`);
console.log(`Listings: ${LISTINGS.length}, default demo target 64473584 (SAMPLE 6BR 4BA).`);
console.log('Run:  npm run replay   then open http://localhost:8787');
