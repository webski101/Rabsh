'use strict';
/**
 * The demand heuristic — pure functions, no I/O, no dependencies.
 * Runs in Node (require) AND in the browser (served as /lib/demand.js) so the
 * elasticity slider can re-score instantly client-side with the exact same
 * math the tests cover.
 *
 * This is NOT ML. Every number is traceable:
 *   ref(d)        = baseline recommended price for d (Wheelhouse's own rec is
 *                   market-calibrated by construction; daily neighborhood
 *                   endpoints are not needed per smoke test)
 *   base_occ(d)   = interpolated from KPI forward occupancy windows
 *                   (0_7 / 0_30 / 0_60 / 0_90), shaped by monthly seasonality;
 *                   falls back to clamp(0.65 * seasonality_factor, .15, .95)
 *   P(booked|d)   = clamp(base_occ * (sim/ref)^(-E), 0, 0.98)
 *   E             = price elasticity, default 1.8, UI slider 1.0–3.0
 *   revenue(d)    = sim_price(d) * P(booked|d)
 */
(function (global) {
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  const DEFAULT_ELASTICITY = 1.8;
  const MAX_P = 0.98;

  /**
   * Normalize monthly seasonality into a {1..12: factor} map with mean 1.0.
   * Accepts the API's rows ([{month, factor|value|seasonality}...]) or a plain
   * map. Missing months get 1.0.
   */
  function seasonalityMap(raw) {
    const map = {};
    for (let m = 1; m <= 12; m++) map[m] = 1.0;
    if (!raw) return map;
    const rows = Array.isArray(raw) ? raw : raw.data && Array.isArray(raw.data) ? raw.data : null;
    if (rows) {
      for (const row of rows) {
        const m = Number(row.month);
        const f = Number(row.factor ?? row.value ?? row.seasonality);
        if (m >= 1 && m <= 12 && isFinite(f) && f > 0) map[m] = f;
      }
    } else if (typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        const m = Number(k);
        if (m >= 1 && m <= 12 && isFinite(Number(v)) && Number(v) > 0) map[m] = Number(v);
      }
    }
    // normalize to mean 1 so it shapes, never scales, occupancy
    const mean = Object.values(map).reduce((a, b) => a + b, 0) / 12;
    if (mean > 0) for (let m = 1; m <= 12; m++) map[m] = map[m] / mean;
    return map;
  }

  /**
   * Piecewise per-window occupancy from cumulative KPI forward windows.
   * KPI gives averages over 0-7, 0-30, 0-60, 0-90 days out; de-cumulate to get
   * the marginal occupancy of each band, then pick by day offset.
   * kpiOcc: {"0_7": x, "0_30": x, "0_60": x, "0_90": x, "0_365": x} (any subset)
   */
  function occupancyBands(kpiOcc) {
    if (!kpiOcc) return null;
    const w = (name) => {
      const v = Number(kpiOcc[name]);
      return isFinite(v) && v >= 0 ? v : null;
    };
    const o7 = w('0_7');
    const o30 = w('0_30');
    const o60 = w('0_60');
    const o90 = w('0_90');
    const o365 = w('0_365');
    if (o7 == null && o30 == null && o60 == null && o90 == null) return null;

    const bands = [];
    const push = (maxOffset, value, fallback) => {
      const v = value != null ? value : fallback;
      if (v != null) bands.push({ maxOffset, occ: clamp(v, 0, 1) });
    };
    push(7, o7, o30 ?? o60 ?? o90);
    // de-cumulate: occ over days 8..30 = (o30*30 - o7*7) / 23, etc.
    const band30 = o30 != null && o7 != null ? (o30 * 30 - o7 * 7) / 23 : o30;
    push(30, band30, o30 ?? o7);
    const band60 = o60 != null && o30 != null ? (o60 * 60 - o30 * 30) / 30 : o60;
    push(60, band60, o60 ?? o30);
    const band90 = o90 != null && o60 != null ? (o90 * 90 - o60 * 60) / 30 : o90;
    push(90, band90, o90 ?? o60);
    const band365 = o365 != null && o90 != null ? (o365 * 365 - o90 * 90) / 275 : o365;
    push(365, band365, o90 ?? o60 ?? o30);
    return bands;
  }

  /**
   * base_occ for a stay date.
   * @param {number} dayOffset  days from today (0-based)
   * @param {number} month      1-12 month of the stay date
   * @param {object|null} bands from occupancyBands(), or null
   * @param {object} seasonality normalized map from seasonalityMap()
   */
  function baseOcc(dayOffset, month, bands, seasonality) {
    const sf = (seasonality && seasonality[month]) || 1.0;
    let occ;
    if (bands && bands.length) {
      const band = bands.find((b) => dayOffset <= b.maxOffset) || bands[bands.length - 1];
      occ = band.occ * sf;
    } else {
      occ = 0.65 * sf;
    }
    return clamp(occ, 0.15, 0.95);
  }

  /** P(booked | day) — the elasticity core. */
  function pBooked(simPrice, refPrice, base, elasticity) {
    if (!(refPrice > 0) || !(simPrice > 0)) return 0;
    const ratio = simPrice / refPrice;
    return clamp(base * Math.pow(ratio, -elasticity), 0, MAX_P);
  }

  /**
   * Evaluate one simulated calendar against the reference calendar.
   * @param {Array<{stay_date, price}>} simDays
   * @param {Map<string, number>|object} refByDate  stay_date -> reference price
   * @param {object} opts { elasticity, horizon, bands, seasonality, startDate }
   * @returns {{ rows, totals }} rows have every intermediate number (traceable UI)
   */
  function evaluateCalendar(simDays, refByDate, opts = {}) {
    const E = opts.elasticity ?? DEFAULT_ELASTICITY;
    const horizon = opts.horizon ?? 90;
    const bands = opts.bands ?? null;
    const seasonality = opts.seasonality ?? seasonalityMap(null);
    const start = opts.startDate ? new Date(opts.startDate + 'T00:00:00Z') : null;

    const lookup = (date) =>
      refByDate instanceof Map ? refByDate.get(date) : refByDate[date];

    const rows = [];
    for (const day of simDays) {
      if (rows.length >= horizon) break;
      const ref = Number(lookup(day.stay_date));
      const price = Number(day.price);
      if (!(ref > 0) || !(price > 0)) continue;
      const d = new Date(day.stay_date + 'T00:00:00Z');
      const month = d.getUTCMonth() + 1;
      const offset = start ? Math.round((d - start) / 86400000) : rows.length;
      const base = baseOcc(Math.max(0, offset), month, bands, seasonality);
      const p = pBooked(price, ref, base, E);
      rows.push({
        stay_date: day.stay_date,
        price,
        ref,
        ratio: price / ref,
        base_occ: base,
        p_booked: p,
        expected_revenue: price * p,
      });
    }

    const revenue = rows.reduce((s, r) => s + r.expected_revenue, 0);
    const expNights = rows.reduce((s, r) => s + r.p_booked, 0);
    return {
      rows,
      totals: {
        revenue,
        expected_nights: expNights,
        occupancy: rows.length ? expNights / rows.length : 0,
        adr: expNights > 0 ? revenue / expNights : 0,
        days: rows.length,
        elasticity: E,
      },
    };
  }

  const api = {
    clamp,
    DEFAULT_ELASTICITY,
    seasonalityMap,
    occupancyBands,
    baseOcc,
    pBooked,
    evaluateCalendar,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.RabshDemand = api;
})(typeof window !== 'undefined' ? window : globalThis);
