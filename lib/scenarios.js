'use strict';
/**
 * The named strategy set. Each scenario = preview payload + one-line thesis.
 *
 * Design rules:
 * - "Hold Course" is ALWAYS included (empty payload) — it is the control every
 *   comparison is measured against.
 * - Base price levels use ABSOLUTE base_price anchored to the conservative /
 *   recommended / aggressive values the preview endpoint itself returns —
 *   never base_price_adjustment, because the smoke test proved that field is a
 *   MULTIPLIER (1.1 = +10%) despite docs saying "percentage". Absolute prices
 *   cannot suffer a 10x semantics error on stage.
 * - Sub-shapes below were corrected against the live API's 400 errors on
 *   2026-07-23: last_minute_discount / far_future_premium require an outer
 *   `type` (CON/REC/AGG) alongside `rules`, and each rule uses the documented
 *   `time_based` shape (days_before / days_after / value) — NOT a bespoke
 *   {active, amount, amount_type} shape. day_of_week uses a `day_of_week`
 *   rule type with a 7-element `day_of_week_values` array (index 0 = Sunday).
 *   These are still best-effort against the docs — if record still 400s,
 *   fix HERE only and rerun `npm run record`.
 */

/**
 * @param {object} anchors { con, rec, agg } absolute base prices from the
 *                 Hold Course preview response (base_price_conservative etc.)
 */
function buildScenarios(anchors) {
  const { con, rec, agg } = anchors;

  // Corrected shape helpers — single place to adjust against the live API.
  const lastMinute = (strength) => ({
    type: 'REC',
    rules: [
      { type: 'time_based', days_before: 3, days_after: 0, value: strength },
      { type: 'time_based', days_before: 7, days_after: 0, value: Math.round(strength * 0.6) },
      { type: 'time_based', days_before: 14, days_after: 0, value: Math.round(strength * 0.3) },
    ],
  });
  const farFuture = (percent) => ({
    type: 'REC',
    rules: [
      { type: 'time_based', days_after: 90, value: percent },
    ],
  });
  // day_of_week_values: 7-element array, index 0 = Sunday. null = fall through.
  const weekendUplift = (friPct, satPct) => ({
    type: 'REC',
    rules: [
      {
        type: 'day_of_week',
        day_of_week_values: [null, null, null, null, null, friPct, satPct],
      },
    ],
  });

  const scenarios = [
    {
      id: 'hold_course',
      name: 'Hold Course',
      thesis: 'Your current strategy, projected forward — the control.',
      payload: {},
    },
    {
      id: 'conservative_floor',
      name: 'Conservative Floor',
      thesis: 'Protect occupancy: conservative base and gentle seasonality.',
      payload: {
        base_price: con,
        seasonality_adjustment: { type: 'CON', rules: [] },
      },
    },
    {
      id: 'recommended',
      name: 'Recommended',
      thesis: "Wheelhouse's own recommended base and seasonality, unmodified.",
      payload: {
        base_price: rec,
        seasonality_adjustment: { type: 'REC', rules: [] },
      },
    },
    {
      id: 'aggressive_growth',
      name: 'Aggressive Growth',
      thesis: 'Push rate: aggressive base and aggressive seasonal peaks.',
      payload: {
        base_price: agg,
        seasonality_adjustment: { type: 'AGG', rules: [] },
      },
    },
    {
      id: 'weekend_warrior',
      name: 'Weekend Warrior',
      thesis: 'Recommended base with Friday/Saturday priced to demand.',
      payload: {
        base_price: rec,
        day_of_week: weekendUplift(10, 12),
      },
    },
    {
      id: 'fill_the_gaps',
      name: 'Fill the Gaps',
      thesis: 'Recommended base, aggressive last-minute discounting to convert empty nights.',
      payload: {
        base_price: rec,
        last_minute_discount: lastMinute(25),
      },
    },
    {
      id: 'book_early_premium',
      name: 'Book Early Premium',
      thesis: 'Recommended base, premium on far-future dates while supply is scarce.',
      payload: {
        base_price: rec,
        far_future_premium: farFuture(12),
      },
    },
    {
      id: 'occupancy_first',
      name: 'Occupancy First',
      thesis: 'Conservative base plus strong last-minute discounts — fill every night.',
      payload: {
        base_price: con,
        last_minute_discount: lastMinute(30),
      },
    },
    {
      id: 'revenue_max',
      name: 'Revenue Max',
      thesis: 'Aggressive base, far-future premium, weekend uplift — maximum rate posture.',
      payload: {
        base_price: agg,
        far_future_premium: farFuture(10),
        day_of_week: weekendUplift(8, 10),
      },
    },
  ];

  for (const s of scenarios) validatePayload(s.payload);
  return scenarios;
}

/** Guard API-documented invariants before anything hits the network. */
function validatePayload(payload) {
  if (
    payload.occupancy_pacing &&
    Object.keys(payload.occupancy_pacing).length > 0 &&
    !(payload.occupancy_pacing.adjusted && payload.occupancy_pacing.pacing)
  ) {
    throw new Error(
      'occupancy_pacing, if non-empty, must include BOTH "adjusted" and "pacing" (API doc requirement).'
    );
  }
  if (payload.base_price_adjustment === 1.0 || payload.base_price_adjustment === 0) {
    throw new Error(
      'base_price_adjustment of 1.0/0 must be omitted, not sent (API rejects it). It is a MULTIPLIER: 1.1 = +10%.'
    );
  }
  return payload;
}

module.exports = { buildScenarios, validatePayload };
