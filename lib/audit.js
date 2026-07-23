'use strict';
/**
 * SHA-256 hash-chained JSONL audit log.
 *
 * Each line: { seq, ts, event, payload, payload_hash, prev_hash, hash }
 *   payload_hash = sha256(stableStringify(payload))
 *   hash         = sha256(prev_hash + "|" + seq + "|" + ts + "|" + event + "|" + payload_hash)
 *
 * The first line's prev_hash is the fixed genesis constant, so an attacker
 * cannot silently truncate the head of the log either.
 */

const fs = require('node:fs');
const path = require('node:path');
const { sha256, stableStringify } = require('./client');

const GENESIS = 'rabsh-genesis-0000000000000000000000000000000000000000000000000000';
const DEFAULT_LOG = path.join(__dirname, '..', 'data', 'audit.jsonl');

function lineHash(prevHash, seq, ts, event, payloadHash) {
  return sha256(`${prevHash}|${seq}|${ts}|${event}|${payloadHash}`);
}

function createAudit(logPath = DEFAULT_LOG) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  function readAll() {
    if (!fs.existsSync(logPath)) return [];
    return fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  function append(event, payload) {
    const lines = readAll();
    const prev = lines.length ? lines[lines.length - 1] : null;
    const seq = prev ? prev.seq + 1 : 0;
    const ts = new Date().toISOString();
    const payload_hash = sha256(stableStringify(payload ?? null));
    const prev_hash = prev ? prev.hash : GENESIS;
    const entry = {
      seq,
      ts,
      event,
      payload: payload ?? null,
      payload_hash,
      prev_hash,
      hash: lineHash(prev_hash, seq, ts, event, payload_hash),
    };
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
    return entry;
  }

  function tail(n = 50) {
    const lines = readAll();
    return lines.slice(-n);
  }

  return { append, tail, readAll, logPath };
}

module.exports = { createAudit, lineHash, GENESIS, DEFAULT_LOG };
