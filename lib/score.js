'use strict';
/**
 * Scoring, ranking, risk flags, and the plain-English rationale generator.
 * Dual-environment like demand.js (Node require + browser <script>).
 */
(function (global) {
  const demand =
    typeof module !== 'undefined' && module.exports
      ? require('./demand')
      : global.RabshDemand;

  /**
   * Risk flags for one scored strategy.
   * - Floor proximity: only if min/max floor rows exist (smoke test: none on
   *   the sample listings, so this usually stays silent).
   * - Overpriced: >25% of days priced >25% above the market reference
   *   (baseline recommended — a stand-in for neighborhood P75, which the
   *   daily neighborhood endpoints would supply if chased later).
   */
  function riskFlags(rows, floorByDate) {
    const flags = [];
    if (!rows.length) return flags;

    const overRef = rows.filter((r) => r.ratio > 1.25).length / rows.length;
    if (overRef > 0.25) {
      flags.push({
        code: 'above_market',
        label: `${Math.round(overRef * 100)}% of days priced >25% above market reference`,
      });
    }
    const underRef = rows.filter((r) => r.ratio < 0.75).length / rows.length;
    if (underRef > 0.4) {
      flags.push({
        code: 'deep_discount',
        label: `${Math.round(underRef * 100)}% of days priced >25% below market reference`,
      });
    }
    if (floorByDate) {
      const nearFloor = rows.filter((r) => {
        const floor = floorByDate[r.stay_date];
        return floor > 0 && r.price <= floor * 1.05;
      }).length / rows.length;
      if (nearFloor > 0.4) {
        flags.push({
          code: 'floor_proximity',
          label: `${Math.round(nearFloor * 100)}% of days within 5% of the configured price floor`,
        });
      }
    }
    return flags;
  }

  const money = (x, currency) =>
    (currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$') +
    Math.round(x).toLocaleString('en-US');
  const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';

  /** Plain-English rationale vs the Hold Course control. */
  function rationale(strategy, hold, currency) {
    if (!hold || strategy.id === hold.id) {
      return (
        'This is the control: your current preferences projected forward with no changes. ' +
        'Every other strategy is measured against this number.'
      );
    }
    const dRev = strategy.totals.revenue - hold.totals.revenue;
    const dOcc = strategy.totals.occupancy - hold.totals.occupancy;
    const dAdr = strategy.totals.adr - hold.totals.adr;
    const parts = [];
    parts.push(
      `${strategy.name} projects ${money(strategy.totals.revenue, currency)} over the next ` +
        `${strategy.totals.days} days — ${dRev >= 0 ? 'up' : 'down'} ${money(Math.abs(dRev), currency)} ` +
        `(${pct(dRev / Math.max(1, hold.totals.revenue))}) vs holding course.`
    );
    if (Math.abs(dOcc) >= 0.005) {
      parts.push(
        `It trades ${dOcc >= 0 ? 'higher' : 'lower'} projected occupancy ` +
          `(${(strategy.totals.occupancy * 100).toFixed(0)}% vs ${(hold.totals.occupancy * 100).toFixed(0)}%)`
      );
      parts.push(
        `${dAdr >= 0 ? 'with' : 'against'} a ${dAdr >= 0 ? 'higher' : 'lower'} average nightly rate ` +
          `(${money(strategy.totals.adr, currency)} vs ${money(hold.totals.adr, currency)}).`
      );
    } else {
      parts.push(
        `Occupancy is roughly flat; the difference comes from rate: ` +
          `${money(strategy.totals.adr, currency)} vs ${money(hold.totals.adr, currency)} ADR.`
      );
    }
    if (strategy.thesis) parts.push(`Thesis: ${strategy.thesis}`);
    if (strategy.risks.length) {
      parts.push(`Caution: ${strategy.risks.map((r) => r.label).join('; ')}.`);
    }
    return parts.join(' ');
  }

  /**
   * Score all simulated strategies.
   * @param {Array} previews   [{ id, name, thesis, payload, days:[{stay_date,price}], error? }]
   * @param {object} ctx       { refByDate, bands, seasonality, startDate, floorByDate, currency }
   * @param {object} opts      { elasticity, horizon }
   */
  function scoreAll(previews, ctx, opts = {}) {
    const scored = [];
    for (const prev of previews) {
      if (prev.error || !prev.days || !prev.days.length) {
        scored.push({ ...prev, failed: true, totals: null, rows: [], risks: [] });
        continue;
      }
      const { rows, totals } = demand.evaluateCalendar(prev.days, ctx.refByDate, {
        elasticity: opts.elasticity,
        horizon: opts.horizon,
        bands: ctx.bands,
        seasonality: ctx.seasonality,
        startDate: ctx.startDate,
      });
      scored.push({
        ...prev,
        failed: false,
        rows,
        totals,
        risks: riskFlags(rows, ctx.floorByDate),
      });
    }

    const ok = scored.filter((s) => !s.failed);
    ok.sort((a, b) => b.totals.revenue - a.totals.revenue);
    const hold = ok.find((s) => s.id === 'hold_course') || null;
    for (const s of ok) {
      s.delta_vs_hold = hold ? s.totals.revenue - hold.totals.revenue : 0;
      s.delta_pct_vs_hold =
        hold && hold.totals.revenue > 0 ? s.delta_vs_hold / hold.totals.revenue : 0;
      s.rationale = rationale(s, hold, ctx.currency);
    }
    return { ranked: ok, failed: scored.filter((s) => s.failed), hold };
  }

  /**
   * Sensitivity readout: winner at each elasticity on a grid, so the UI can
   * show "the recommendation is stable from E=1.0 to E=2.25, then flips".
   */
  function sensitivity(previews, ctx, horizon, grid) {
    const points = grid || [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0];
    return points.map((E) => {
      const { ranked } = scoreAll(previews, ctx, { elasticity: E, horizon });
      const top = ranked[0];
      return { elasticity: E, winner_id: top ? top.id : null, winner_name: top ? top.name : null };
    });
  }

  const api = { scoreAll, sensitivity, riskFlags, rationale };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.RabshScore = api;
})(typeof window !== 'undefined' ? window : globalThis);
