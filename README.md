# RABSH — Agentic Revenue Strategy Simulator + Executor

Wheelhouse Revenue Management Hackathon 2026.

**RABSH answers the question every revenue manager asks — *what would happen if I changed my strategy?* — by actually running the alternatives through Wheelhouse's own pricing engine (the preview endpoint), scoring them against the market, and applying the winner with a full cryptographic paper trail.**

Zero npm dependencies. Node 18+ only (`fetch`, `node:http`, `node:crypto`, `node:fs`).

## Live demo

**https://rabsh.onrender.com/** — running in LIVE mode against Wheelhouse's sandbox SF listings.

> ⏳ Free-tier hosting spins down when idle — the first load may take **30–60 seconds** to wake. Please wait a moment.
>
> The listings are Wheelhouse-provided demo properties (SF market), so **SIMULATE ALL** fires real preview calls against the real API — previews never modify anything. The executor's APPLY step performs a genuine `PUT`; use deliberately.

## The loop

1. **Generate** — 9 named strategies (base level × seasonality × last-minute × far-future × day-of-week) plus a custom composer. *Hold Course* (empty payload) is always included as the control.
2. **Simulate** — each payload goes through `POST /preferences/{id}/preview` → a full projected price calendar, **nothing saved**.
3. **Score** — a transparent, deterministic demand heuristic converts each calendar to expected revenue. Not ML; every number in the UI traces to its inputs.
4. **Rank & explain** — leaderboard with Δ vs Hold Course, occupancy/ADR estimates, risk flags, plain-English rationale, elasticity sensitivity readout.
5. **Execute** — `GET /preferences` → deep-merge → **exact diff shown** → one-click confirm → `PUT` complete object → readback. Never blind writes; rule arrays always sent complete (the API replaces them wholesale).
6. **Audit** — every step appends to a SHA-256 hash-chained JSONL log. `VERIFY CHAIN` proves integrity; tamper with any line and it fails at that line.

## Quick start
Fallback/dev demo with zero network and zero keys:

npm run fixture # writes a SYNTHETIC cache (clearly marked)
npm run replay # serve entirely from cache

open http://localhost:8787 → SIMULATE ALL
Live:

set WHEELHOUSE_KEY_RO=... # read-only key (all GETs + preview)
set WHEELHOUSE_KEY_RW=... # optional; without it the executor degrades to copy-payload mode
npm start

Before the demo — record a real run into the cache, then rehearse in replay:

npm run record
npm run replay

npm test # 22 tests: demand math, scoring, merge/diff, chain verify


## Architecture
                ┌─────────────────────────────────────────────┐
                │                ui/index.html                │
                │   leaderboard · SVG chart · detail · diff   │
                │   elasticity slider re-scores CLIENT-SIDE   │
                │   using the same lib/demand.js + score.js   │
                └───────┬─────────────────────────┬───────────┘
                        │ /api/* (read)           │ /api/execute/* (write)
                ┌───────▼───────────┐     ┌───────▼───────────┐
                │    server.js      │     │  lib/executor.js  │
                │    node:http      │     │  GET→merge→diff→  │
                └───────┬───────────┘     │  confirm→PUT→read │
          ┌─────────────┼──────────┐      └───────┬───────────┘
  ┌───────▼──────┐ ┌────▼─────┐ ┌──▼────────┐     │
  │lib/simulate  │ │lib/demand│ │ lib/audit │◄────┘ every event
  │ scenario     │ │lib/score │ │ SHA-256   │
  │ fan-out +    │ │ the brain│ │ hash chain│──► lib/verify.js
  │ calibration  │ │ (pure)   │ └───────────┘
  └───────┬──────┘ └──────────┘
  ┌───────▼──────────────────────────────┐
  │ lib/client.js — token bucket 60/min, │
  │ backoff (429/423/409), cache-to-disk,│
  │ --replay = zero network              │
  ├──────────────────────────────────────┤
  │ RO key: GETs + preview ONLY.         │
  │ A read-only client HAS NO put method │
  │ — simulation physically cannot write.│
  │ RW key exists only inside executor.  │
  └──────────────┬───────────────────────┘
                 ▼
    Wheelhouse RM API (ss_api/v1)

## The demand heuristic (auditable, tunable — not ML)

ref(d) = baseline recommended price for d (market-calibrated by construction)
base_occ(d) = KPI forward-occupancy windows (0_7/0_30/0_60/0_90), de-cumulated
into bands, shaped by monthly seasonality
fallback: clamp(0.65 × seasonality_factor(month), 0.15, 0.95)
P(booked|d) = clamp(base_occ × (sim_price/ref)^(-E), 0, 0.98)
E = elasticity slider, 1.0–3.0 (default 1.8), with sensitivity readout
Score = Σ sim_price(d) × P(booked|d) over 30/60/90-day horizon


Risk flags: >25% of days priced >25% above market reference; deep-discount flag; floor proximity (only when min/max rows exist — the sample listings have none).

## Verified API gotchas baked in

- **`base_price_adjustment` is a MULTIPLIER** (1.1 = +10%), despite docs saying "percentage". A calibration probe runs before every fan-out and asserts day-1 ≈ baseline × 1.1 (±2%). Named scenarios use *absolute* `base_price` anchored to the preview's own con/rec/agg values, so they are immune regardless.
- Preview returns **201** — all 2xx treated as success.
- PUT rule arrays are **replaced, not merged** — the executor always read-merge-writes the complete object.
- 422 = listing not covered by a market → surfaced per-scenario, pick another listing.
- 546-day horizon; UI scores/charts a 30/60/90-day slice.
- `last_minute_discount` / `far_future_premium` require an outer `type` (CON/REC/AGG) alongside `rules` (API 400s with "type is missing" otherwise); rules use the documented `time_based` shape (`days_before`/`days_after`/`value`), and `day_of_week` uses a `day_of_week` rule with a 7-element `day_of_week_values` array (index 0 = Sunday). All shapes now **verified against the live API** — all 9 scenarios pass.
- `far_future_premium` rules **500 (server error) when `days_before: 0` is sent explicitly** — omit the key instead of zeroing it. (Reported upstream.)

## Live-verified (2026-07-23)

- Full 9-scenario fan-out recorded against the live API — calibration probe passed (multiplier confirmed).
- Real execution proven end-to-end: `executor.plan` → `executor.applied` (PUT + readback) captured in the hash chain on a sandbox listing.
- Chain tamper test: editing any line of `data/audit.jsonl` fails verification at exactly that line.

## Demo script (~4 min)

1. `npm run replay` (rehearsed cache; nothing can die on stage) — or `npm start` live.
2. **SIMULATE ALL** → 9 strategies through Wheelhouse's real pricing engine. Point at the calibration line: "we verify the API's price math before we trust it."
3. Leaderboard headline: **"+$X over the next 90 days vs. holding course."** Click the winner → rationale + exact payload + per-day projection.
4. **Elasticity slider**: "if your market is more price-sensitive, watch the recommendation change" — winner flips; sensitivity strip shows where.
5. Chart hover: per-day prices + Wheelhouse attribution factors ("why is this night priced this way").
6. **PLAN EXECUTION** → exact diff of current vs proposed preferences → **APPLY** → readback confirms. (RO mode: copy the exact PUT payload.)
7. Audit trail → **VERIFY CHAIN** ✓ → tamper one line of `data/audit.jsonl` in an editor → verify again → ✗ broken at that line. "Every price change this agent makes is provable."

## Files

server.js node:http server; static UI + /api/* (RO) + /api/execute/* (RW)
lib/client.js rate-limited fetch, backoff, disk cache, --replay
lib/scenarios.js the named strategy payloads (+ payload validation)
lib/simulate.js preview fan-out + calibration probe (RO client only)
lib/demand.js heuristic — pure functions, browser + Node
lib/score.js ranking, risk flags, rationale, sensitivity
lib/executor.js read-merge-diff-confirm-PUT-readback (only writer)
lib/audit.js hash-chained JSONL appender
lib/verify.js chain walker (also a CLI: npm run verify-audit)
ui/index.html single-file dark dashboard, no frameworks
test/run.js 22 tests (node:test)
scripts/record-demo.js record a live run into data/cache for replay
scripts/make-synth-cache.js SYNTHETIC dev fixture (marked in demo-manifest.json)
