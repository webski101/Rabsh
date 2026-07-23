'use strict';
/**
 * Fan-out simulation over the preview endpoint. Sequential — the client's
 * global limiter provides the 60/min spacing; this module never parallelizes.
 *
 * Receives a READ-ONLY client (no .put method exists on it), so the simulation
 * engine is physically incapable of writes.
 */

const { buildScenarios, validatePayload } = require('./scenarios');

function previewPath(listingId, channel) {
  return `/preferences/${listingId}/preview?channel=${encodeURIComponent(channel)}`;
}

function normalizeDays(previewResponse) {
  const days = (previewResponse && previewResponse.data) || [];
  return days.map((d) => ({
    stay_date: d.stay_date,
    price: Number(d.price),
    currency: d.currency,
    custom_type: d.custom_type ?? null,
  }));
}

/**
 * ⚠ Calibration probe (mandatory before any adjustment-based math ships):
 * base_price_adjustment is a MULTIPLIER per the smoke test (1.1 = +10%,
 * despite docs saying "percentage"). Send 1.1 and assert day-1 price is
 * baseline × 1.1 within ±2%. If not, adjustment semantics are UNKNOWN — the
 * custom composer must block that field. Named scenarios use absolute
 * base_price and are immune either way.
 */
async function calibrate(client, listingId, channel, holdDays) {
  const holdDay1 = holdDays.find((d) => d.price > 0);
  if (!holdDay1) return { ok: false, reason: 'No baseline day-1 price to calibrate against.' };
  try {
    const res = await client.post(previewPath(listingId, channel), {
      base_price_adjustment: 1.1,
    });
    const probeDays = normalizeDays(res.data);
    const probeDay1 = probeDays.find((d) => d.stay_date === holdDay1.stay_date);
    if (!probeDay1) return { ok: false, reason: 'Probe returned no matching day.' };
    const observed = probeDay1.price / holdDay1.price;
    const ok = Math.abs(observed - 1.1) <= 0.022; // ±2%
    return {
      ok,
      semantics: ok ? 'multiplier' : 'unknown',
      observed_ratio: Number(observed.toFixed(4)),
      expected_ratio: 1.1,
      day: holdDay1.stay_date,
      baseline_price: holdDay1.price,
      probe_price: probeDay1.price,
      reason: ok
        ? 'base_price_adjustment confirmed as multiplier (1.1 = +10%).'
        : `Probe ratio ${observed.toFixed(3)} ≠ 1.1 — adjustment semantics unverified; adjustment field blocked in composer.`,
    };
  } catch (err) {
    return { ok: false, semantics: 'unknown', reason: `Calibration probe failed: ${err.message}` };
  }
}

/**
 * Run the full simulation pass for one listing.
 * @param {object} client   read-only API client
 * @param {object} listing  { id, channel }
 * @param {object} [audit]  optional audit logger
 * @param {object} [extraScenario] optional { id, name, thesis, payload } (custom composer)
 * @returns {{ previews, calibration, anchors }}
 */
async function simulateAll(client, listing, audit, extraScenario) {
  const { id: listingId, channel } = listing;
  const log = (event, payload) => audit && audit.append(event, payload);

  // Phase 1: Hold Course (empty payload) — control calendar + base price anchors.
  const holdRes = await client.post(previewPath(listingId, channel), {});
  const holdBody = holdRes.data;
  const holdDays = normalizeDays(holdBody);
  const anchors = {
    con: Number(holdBody.base_price_conservative),
    rec: Number(holdBody.base_price_recommended),
    agg: Number(holdBody.base_price_aggressive),
    current: Number(holdBody.base_price),
  };
  log('sim.hold_course', { listing_id: listingId, days: holdDays.length, anchors });

  // Phase 2: calibration probe.
  const calibration = await calibrate(client, listingId, channel, holdDays);
  log('sim.calibration', calibration);

  // Phase 3: remaining scenarios (absolute base_price — immune to the
  // multiplier gotcha even if calibration failed).
  const scenarios = buildScenarios(anchors);
  if (extraScenario) {
    validatePayload(extraScenario.payload);
    scenarios.push({ id: 'custom', name: 'Custom', thesis: 'User-composed strategy.', ...extraScenario });
  }

  const previews = [];
  for (const sc of scenarios) {
    if (sc.id === 'hold_course') {
      previews.push({ ...sc, days: holdDays, status: holdRes.status });
      continue;
    }
    try {
      const res = await client.post(previewPath(listingId, channel), sc.payload);
      const days = normalizeDays(res.data);
      previews.push({ ...sc, days, status: res.status });
      log('sim.preview', { scenario: sc.id, status: res.status, days: days.length });
    } catch (err) {
      const msg =
        err.status === 422
          ? 'Listing not covered by a market (422) — pick another listing.'
          : err.message;
      previews.push({ ...sc, days: [], error: msg, status: err.status || 0 });
      log('sim.preview_failed', { scenario: sc.id, error: msg });
    }
  }

  return { previews, calibration, anchors };
}

module.exports = { simulateAll, calibrate, normalizeDays, previewPath };
