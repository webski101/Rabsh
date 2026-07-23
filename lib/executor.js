'use strict';
/**
 * The only module that ever writes to Wheelhouse. Read-merge-write, never
 * blind: GET /preferences -> deep-merge scenario payload -> exact diff ->
 * (confirm) -> PUT complete object -> GET readback.
 *
 * Executor gotcha (docs are explicit): preference fields that are rule ARRAYS
 * are FULLY REPLACED by PUT, never merged. Any rule omitted from an array is
 * permanently deleted. So the merge below always carries the complete fetched
 * object forward and arrays in the payload replace wholesale — we never send
 * a partial array we didn't construct deliberately.
 */

const { createClient, sha256, stableStringify, REPLAY } = require('./client');

// Fields the API owns; never echo them back in a PUT body.
const READ_ONLY_FIELDS = ['id', 'listing_id', 'created_at', 'updated_at', 'wheelhouse_id'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge: objects merge recursively, arrays REPLACE (rule-array rule). */
function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? base : patch;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (Array.isArray(v)) out[k] = v;
    else if (isPlainObject(v) && isPlainObject(base[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

/** Recursive diff -> flat list of { path, before, after }. */
function diffObjects(before, after, prefix = '') {
  const changes = [];
  const keys = new Set([
    ...Object.keys(isPlainObject(before) ? before : {}),
    ...Object.keys(isPlainObject(after) ? after : {}),
  ]);
  for (const k of keys) {
    const p = prefix ? `${prefix}.${k}` : k;
    const b = isPlainObject(before) ? before[k] : undefined;
    const a = isPlainObject(after) ? after[k] : undefined;
    if (stableStringify(b ?? null) === stableStringify(a ?? null)) continue;
    if (isPlainObject(b) && isPlainObject(a)) {
      changes.push(...diffObjects(b, a, p));
    } else {
      changes.push({ path: p, before: b === undefined ? null : b, after: a === undefined ? null : a });
    }
  }
  return changes;
}

function stripReadOnly(prefs) {
  const out = { ...prefs };
  for (const f of READ_ONLY_FIELDS) delete out[f];
  return out;
}

function createExecutor({ roKey, rwKey, audit }) {
  const reader = createClient({ apiKey: roKey, allowWrite: false });
  const writer = rwKey ? createClient({ apiKey: rwKey, allowWrite: true }) : null;
  const plans = new Map(); // diff_hash -> plan (two-step confirm)

  const mode = REPLAY ? 'replay' : writer ? 'rw' : 'ro';

  /**
   * Step 1: build the exact change. No writes happen here.
   */
  async function plan(listingId, channel, scenarioPayload, scenarioId) {
    const res = await reader.get(
      `/preferences/${listingId}?channel=${encodeURIComponent(channel)}`
    );
    const current = res.data;
    const proposed = deepMerge(current, scenarioPayload);
    const putBody = stripReadOnly(proposed);
    const diff = diffObjects(stripReadOnly(current), putBody);
    const diff_hash = sha256(stableStringify({ listingId, channel, diff }));

    const planObj = {
      listing_id: listingId,
      channel,
      scenario_id: scenarioId || 'custom',
      current,
      proposed,
      put_body: putBody,
      diff,
      diff_hash,
      mode,
      created_at: new Date().toISOString(),
    };
    plans.set(diff_hash, planObj);
    audit &&
      audit.append('executor.plan', {
        listing_id: listingId,
        scenario_id: planObj.scenario_id,
        diff,
        diff_hash,
        mode,
      });
    return planObj;
  }

  /**
   * Step 2: apply — only with the diff_hash from a shown plan (one-click
   * confirm in the UI maps to exactly this call).
   */
  async function apply(diffHash) {
    const p = plans.get(diffHash);
    if (!p) {
      throw new Error('No pending plan for that diff hash — re-run the plan step (prefs may have changed).');
    }
    if (mode === 'replay') {
      audit && audit.append('executor.simulated_apply', { diff_hash: diffHash, scenario_id: p.scenario_id });
      return { simulated: true, mode, plan: p, message: 'REPLAY MODE — no write sent. This is the exact PUT that would have been executed.' };
    }
    if (mode === 'ro') {
      audit && audit.append('executor.copy_payload', { diff_hash: diffHash, scenario_id: p.scenario_id });
      return {
        simulated: true,
        mode,
        plan: p,
        message: 'No WHEELHOUSE_KEY_RW configured — copy this exact PUT payload and apply it yourself.',
      };
    }

    const path = `/preferences/${p.listing_id}?channel=${encodeURIComponent(p.channel)}`;
    const putRes = await writer.put(path, p.put_body);
    const readback = await reader.get(path);
    plans.delete(diffHash);
    audit &&
      audit.append('executor.applied', {
        listing_id: p.listing_id,
        scenario_id: p.scenario_id,
        diff_hash: diffHash,
        put_status: putRes.status,
        readback_hash: sha256(stableStringify(readback.data)),
      });
    return { simulated: false, mode, plan: p, put_status: putRes.status, readback: readback.data };
  }

  return { plan, apply, mode, deepMerge, diffObjects };
}

module.exports = { createExecutor, deepMerge, diffObjects, stripReadOnly, READ_ONLY_FIELDS };
