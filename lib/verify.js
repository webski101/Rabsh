'use strict';
/**
 * Walks the audit chain and verifies integrity. Reports the first broken link.
 * Demo moment: edit any line of data/audit.jsonl by hand and watch it fail.
 *
 * Usage: node lib/verify.js [path-to-log]
 */

const fs = require('node:fs');
const { sha256, stableStringify } = require('./client');
const { lineHash, GENESIS, DEFAULT_LOG } = require('./audit');

function verifyChain(logPath = DEFAULT_LOG) {
  if (!fs.existsSync(logPath)) {
    return { ok: true, entries: 0, message: 'Audit log is empty (nothing to verify).' };
  }
  const rawLines = fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim());

  let prevHash = GENESIS;
  for (let i = 0; i < rawLines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(rawLines[i]);
    } catch {
      return { ok: false, entries: rawLines.length, brokenAt: i, reason: 'Line is not valid JSON.' };
    }
    if (entry.seq !== i) {
      return { ok: false, entries: rawLines.length, brokenAt: i, reason: `Sequence gap: expected seq ${i}, found ${entry.seq}.` };
    }
    if (entry.prev_hash !== prevHash) {
      return { ok: false, entries: rawLines.length, brokenAt: i, reason: 'prev_hash does not match the previous line (chain broken or line removed).' };
    }
    const expectedPayloadHash = sha256(stableStringify(entry.payload ?? null));
    if (entry.payload_hash !== expectedPayloadHash) {
      return { ok: false, entries: rawLines.length, brokenAt: i, reason: `Payload was tampered with (event "${entry.event}").` };
    }
    const expectedHash = lineHash(entry.prev_hash, entry.seq, entry.ts, entry.event, entry.payload_hash);
    if (entry.hash !== expectedHash) {
      return { ok: false, entries: rawLines.length, brokenAt: i, reason: `Line hash mismatch (event "${entry.event}" — metadata edited).` };
    }
    prevHash = entry.hash;
  }
  return { ok: true, entries: rawLines.length, head: prevHash, message: `Chain intact: ${rawLines.length} entries verified.` };
}

module.exports = { verifyChain };

if (require.main === module) {
  const result = verifyChain(process.argv[2] || DEFAULT_LOG);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
