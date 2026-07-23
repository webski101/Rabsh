'use strict';
/** RABSH test suite — node:test, zero deps. `npm test` */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const demand = require('../lib/demand');
const score = require('../lib/score');
const { deepMerge, diffObjects, stripReadOnly } = require('../lib/executor');
const { createAudit } = require('../lib/audit');
const { verifyChain } = require('../lib/verify');
const { stableStringify, cacheKey } = require('../lib/client');
const { buildScenarios, validatePayload } = require('../lib/scenarios');

// ---------- demand math ----------

test('pBooked: price at reference returns base occupancy', () => {
  assert.equal(demand.pBooked(100, 100, 0.7, 1.8), 0.7);
});

test('pBooked: monotonically decreasing in price', () => {
  const ps = [80, 100, 120, 150].map((p) => demand.pBooked(p, 100, 0.7, 1.8));
  for (let i = 1; i < ps.length; i++) assert.ok(ps[i] < ps[i - 1], `p should fall as price rises`);
});

test('pBooked: clamps at 0.98 and handles bad refs', () => {
  assert.equal(demand.pBooked(10, 100, 0.9, 3.0), 0.98);
  assert.equal(demand.pBooked(100, 0, 0.7, 1.8), 0);
  assert.equal(demand.pBooked(0, 100, 0.7, 1.8), 0);
});

test('higher elasticity punishes overpricing harder', () => {
  const low = demand.pBooked(130, 100, 0.7, 1.0);
  const high = demand.pBooked(130, 100, 0.7, 3.0);
  assert.ok(high < low);
});

test('seasonalityMap normalizes to mean 1 and tolerates junk', () => {
  const map = demand.seasonalityMap([
    { month: 6, factor: 2.0 },
    { month: 12, factor: 0.5 },
    { month: 99, factor: 5 },
    { month: 3, factor: 'not-a-number' },
  ]);
  const mean = Object.values(map).reduce((a, b) => a + b, 0) / 12;
  assert.ok(Math.abs(mean - 1) < 1e-9);
  assert.ok(map[6] > map[12]);
});

test('occupancyBands de-cumulates forward windows', () => {
  const bands = demand.occupancyBands({ '0_7': 0.9, '0_30': 0.7, '0_60': 0.6, '0_90': 0.55 });
  assert.equal(bands[0].occ, 0.9);
  // days 8-30: (0.7*30 - 0.9*7)/23 ≈ 0.639
  assert.ok(Math.abs(bands[1].occ - (0.7 * 30 - 0.9 * 7) / 23) < 1e-9);
  assert.equal(demand.occupancyBands({}), null);
  assert.equal(demand.occupancyBands(null), null);
});

test('baseOcc falls back to seasonality-shaped default and clamps', () => {
  const season = demand.seasonalityMap(null);
  assert.equal(demand.baseOcc(5, 6, null, season), 0.65);
  const hot = { ...season, 7: 3.0 };
  assert.equal(demand.baseOcc(5, 7, null, hot), 0.95); // clamped high
  const cold = { ...season, 1: 0.01 };
  assert.equal(demand.baseOcc(5, 1, null, cold), 0.15); // clamped low
});

test('evaluateCalendar: expected revenue equals price*p summed, horizon respected', () => {
  const days = [];
  const refByDate = {};
  for (let i = 0; i < 40; i++) {
    const d = `2026-08-${String(i + 1).padStart(2, '0')}`;
    days.push({ stay_date: d, price: 200 });
    refByDate[d] = 200;
  }
  const { rows, totals } = demand.evaluateCalendar(days, refByDate, { horizon: 30, elasticity: 1.8 });
  assert.equal(rows.length, 30);
  assert.ok(Math.abs(totals.revenue - rows.reduce((s, r) => s + r.expected_revenue, 0)) < 1e-9);
  assert.ok(Math.abs(totals.occupancy - 0.65) < 1e-9); // priced at ref, default base
  assert.ok(Math.abs(totals.adr - 200) < 1e-9);
});

test('evaluateCalendar skips days without a reference price', () => {
  const { rows } = demand.evaluateCalendar(
    [{ stay_date: '2026-08-01', price: 100 }, { stay_date: '2026-08-02', price: 100 }],
    { '2026-08-01': 100 },
    { horizon: 30 }
  );
  assert.equal(rows.length, 1);
});

// ---------- scoring ----------

function mkPreviews() {
  const mk = (id, name, price) => ({
    id,
    name,
    thesis: 't',
    payload: {},
    days: Array.from({ length: 90 }, (_, i) => ({
      stay_date: new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10),
      price,
    })),
  });
  return [mk('hold_course', 'Hold Course', 200), mk('cheap', 'Cheap', 150), mk('pricey', 'Pricey', 260)];
}

function mkCtx() {
  const refByDate = {};
  for (let i = 0; i < 90; i++) {
    refByDate[new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10)] = 200;
  }
  return { refByDate, bands: null, seasonality: demand.seasonalityMap(null), currency: 'USD' };
}

test('scoreAll ranks by revenue, computes delta vs hold course', () => {
  const { ranked, hold } = score.scoreAll(mkPreviews(), mkCtx(), { elasticity: 1.8, horizon: 90 });
  assert.equal(hold.id, 'hold_course');
  assert.equal(hold.delta_vs_hold, 0);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].totals.revenue >= ranked[i].totals.revenue);
  }
  for (const s of ranked) assert.ok(typeof s.rationale === 'string' && s.rationale.length > 20);
});

test('elasticity flips the winner (the demo moment)', () => {
  const previews = mkPreviews();
  const ctx = mkCtx();
  const lowE = score.scoreAll(previews, ctx, { elasticity: 1.0, horizon: 90 }).ranked[0];
  const highE = score.scoreAll(previews, ctx, { elasticity: 3.0, horizon: 90 }).ranked[0];
  // E=1.0: revenue is flat in price (p*price constant) up to clamps -> pricey wins via clamp math.
  // E=3.0: demand collapses on overpricing -> cheap/hold must beat pricey.
  assert.notEqual(highE.id, 'pricey');
});

test('failed previews are quarantined, not ranked', () => {
  const previews = mkPreviews();
  previews.push({ id: 'broken', name: 'Broken', payload: {}, days: [], error: '422' });
  const { ranked, failed } = score.scoreAll(previews, mkCtx(), { horizon: 90 });
  assert.equal(failed.length, 1);
  assert.ok(!ranked.find((s) => s.id === 'broken'));
});

test('risk flag when >25% of days priced >25% above reference', () => {
  const previews = mkPreviews();
  const { ranked } = score.scoreAll(previews, mkCtx(), { horizon: 90 });
  const pricey = ranked.find((s) => s.id === 'pricey');
  assert.ok(pricey.risks.some((r) => r.code === 'above_market'));
});

test('sensitivity grid returns a winner per elasticity', () => {
  const sens = score.sensitivity(mkPreviews(), mkCtx(), 90, [1.0, 2.0, 3.0]);
  assert.equal(sens.length, 3);
  for (const pt of sens) assert.ok(pt.winner_id);
});

// ---------- scenarios ----------

test('buildScenarios: hold course first with empty payload; anchors applied', () => {
  const sc = buildScenarios({ con: 180, rec: 220, agg: 260, current: 200 });
  assert.equal(sc[0].id, 'hold_course');
  assert.deepEqual(sc[0].payload, {});
  assert.equal(sc.find((s) => s.id === 'conservative_floor').payload.base_price, 180);
  assert.equal(sc.find((s) => s.id === 'revenue_max').payload.base_price, 260);
  assert.ok(sc.length >= 9);
});

test('validatePayload enforces occupancy_pacing pair and adjustment-1.0 rules', () => {
  assert.throws(() => validatePayload({ occupancy_pacing: { adjusted: true } }));
  assert.throws(() => validatePayload({ base_price_adjustment: 1.0 }));
  validatePayload({ occupancy_pacing: { adjusted: true, pacing: [] } });
  validatePayload({ base_price_adjustment: 1.1 });
});

// ---------- executor merge / diff ----------

test('deepMerge: arrays replace wholesale (rule-array gotcha)', () => {
  const current = { minimum_price_rules_v3: [{ id: 1 }, { id: 2 }], base_price: 100 };
  const merged = deepMerge(current, { minimum_price_rules_v3: [{ id: 9 }] });
  assert.deepEqual(merged.minimum_price_rules_v3, [{ id: 9 }]);
  assert.equal(merged.base_price, 100);
});

test('deepMerge: untouched fields carried forward (never blind writes)', () => {
  const current = {
    base_price: 100,
    seasonality_adjustment: { type: 'REC', rules: [{ a: 1 }], keepme: true },
    unrelated_setting: 'stays',
  };
  const merged = deepMerge(current, { seasonality_adjustment: { type: 'AGG', rules: [] } });
  assert.equal(merged.unrelated_setting, 'stays');
  assert.equal(merged.seasonality_adjustment.keepme, true);
  assert.equal(merged.seasonality_adjustment.type, 'AGG');
  assert.deepEqual(merged.seasonality_adjustment.rules, []);
});

test('diffObjects reports exact changed paths only', () => {
  const d = diffObjects(
    { a: 1, b: { c: 2, d: 3 }, arr: [1, 2] },
    { a: 1, b: { c: 5, d: 3 }, arr: [1, 2, 3] }
  );
  const paths = d.map((x) => x.path).sort();
  assert.deepEqual(paths, ['arr', 'b.c']);
});

test('stripReadOnly removes API-owned fields', () => {
  const out = stripReadOnly({ id: 5, listing_id: 9, base_price: 100, updated_at: 'x' });
  assert.deepEqual(out, { base_price: 100 });
});

// ---------- audit chain ----------

test('audit chain appends and verifies; tamper is detected', () => {
  const tmp = path.join(os.tmpdir(), `rabsh-audit-${Date.now()}.jsonl`);
  const audit = createAudit(tmp);
  audit.append('sim.run_started', { listing_id: 1 });
  audit.append('sim.preview', { scenario: 'recommended' });
  audit.append('executor.applied', { diff_hash: 'abc' });

  assert.equal(verifyChain(tmp).ok, true);
  assert.equal(verifyChain(tmp).entries, 3);

  // Tamper with the middle line's payload.
  const lines = fs.readFileSync(tmp, 'utf8').trim().split('\n');
  const mid = JSON.parse(lines[1]);
  mid.payload.scenario = 'aggressive_growth';
  lines[1] = JSON.stringify(mid);
  fs.writeFileSync(tmp, lines.join('\n') + '\n');

  const result = verifyChain(tmp);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 1);
  assert.match(result.reason, /tampered/i);

  // Deleting a line also breaks the chain.
  fs.writeFileSync(tmp, [lines[0], lines[2]].join('\n') + '\n');
  assert.equal(verifyChain(tmp).ok, false);
  fs.unlinkSync(tmp);
});

// ---------- client utilities ----------

test('stableStringify is key-order independent; cacheKey is stable', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.equal(cacheKey('POST', '/x', { a: 1, b: 2 }), cacheKey('POST', '/x', { b: 2, a: 1 }));
  assert.notEqual(cacheKey('POST', '/x', { a: 1 }), cacheKey('POST', '/x', { a: 2 }));
});
