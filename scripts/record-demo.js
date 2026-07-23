'use strict';
/**
 * Record a full live run into data/cache/ so `npm run replay` can serve the
 * demo with zero network calls. Run this the evening before the demo.
 *
 *   set WHEELHOUSE_KEY_RO=...   (PowerShell: $env:WHEELHOUSE_KEY_RO="...")
 *   npm run record [-- <listing_id>]
 *
 * Read-only: uses only GETs and the preview endpoint. Never writes to the API.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createClient, CACHE_DIR, REPLAY } = require('../lib/client');
const { simulateAll } = require('../lib/simulate');

async function main() {
  if (REPLAY) throw new Error('Remove --replay/RABSH_REPLAY to record a live run.');
  const key = process.env.WHEELHOUSE_KEY_RO;
  if (!key) throw new Error('WHEELHOUSE_KEY_RO is not set.');

  const client = createClient({ apiKey: key, allowWrite: false });

  console.log('Fetching listings…');
  const listings = (await client.get('/listings')).data;
  const rows = listings.data || listings;
  console.log(`  ${rows.length} listings.`);

  const targetId = Number(process.argv[2]) || 64473584;
  const targets = rows.filter((l) => l.id === targetId).length
    ? rows.filter((l) => l.id === targetId)
    : rows.slice(0, 1);

  for (const listing of targets) {
    const { id, channel } = listing;
    const q = `?channel=${encodeURIComponent(channel)}`;
    console.log(`Recording listing ${id} (${listing.name || ''}, channel=${channel})…`);

    await client.get(`/listings/${id}/price_recommendations${q}&attribution=true`);
    for (const p of [`/listings/${id}/kpis${q}`, `/listings/${id}/monthly_seasonality${q}`, `/listings/${id}/min_max_prices${q}`]) {
      try {
        await client.get(p);
      } catch (err) {
        console.warn(`  (optional) ${p} -> ${err.message}`);
      }
    }
    await client.get(`/preferences/${id}${q}`);

    console.log('  Running full scenario fan-out (rate-limited, ~15s)…');
    const sim = await simulateAll(client, { id, channel }, null);
    console.log(`  Calibration: ${sim.calibration.ok ? 'OK' : 'FAILED'} — ${sim.calibration.reason}`);
    for (const p of sim.previews) {
      console.log(`  ${p.error ? '✗' : '✓'} ${p.name}${p.error ? ' — ' + p.error : ` (${p.days.length} days)`}`);
    }
  }

  fs.writeFileSync(
    path.join(CACHE_DIR, 'demo-manifest.json'),
    JSON.stringify(
      { synthetic: false, note: 'Recorded from the LIVE Wheelhouse API.', generated_at: new Date().toISOString(), default_listing: targetId },
      null,
      2
    )
  );
  console.log(`\nDone. Cache at ${CACHE_DIR}. Demo fallback: npm run replay`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
