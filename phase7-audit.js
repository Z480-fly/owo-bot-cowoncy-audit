#!/usr/bin/env node
'use strict';

/*
 * Phase 7 audit.
 *
 * This script has no runtime dependencies. It checks:
 *   1. the displayed EV rules (+1 win, 0 push, -1 loss; both-bust push);
 *   2. card-entry validation in the embedded advisor core;
 *   3. 100,000 random reachable visible states against the independent exact DP;
 *   4. static privacy/offline properties of blackjack-advisor.html.
 *
 * It never supplies the dealer hole card to the advisor.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const HTML_PATH = path.join(ROOT, 'blackjack-advisor.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

function fail(message) {
  console.error(`AUDIT FAILURE: ${message}`);
  process.exit(1);
}

function close(a, b, tolerance = 1e-9) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function assertClose(label, actual, expected, tolerance = 1e-9) {
  if (!close(actual, expected, tolerance)) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
}

/* ------------------------------------------------------------------------- */
/* Load the embedded advisor core in an isolated VM.                         */
/* ------------------------------------------------------------------------- */

const coreMatch = html.match(/<script id="advisor-core">([\s\S]*?)<\/script>/);
if (!coreMatch) fail('could not find <script id="advisor-core"> in blackjack-advisor.html');

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(coreMatch[1], sandbox, { filename: 'blackjack-advisor-core.js' });
const advisor = sandbox.window.BlackjackAdvisorCore;
if (!advisor) fail('advisor core did not export BlackjackAdvisorCore');

const solver = require('./finite-deck-solver.js');
const reference = solver.createVisibleEvaluator('51-push');
const lossReference = solver.createVisibleEvaluator('51-loss');
const BASE = solver.BASE_51;

/* ------------------------------------------------------------------------- */
/* Independent dealer distribution used for rule-level checks.               */
/*                                                                           */
/* This is intentionally separate from the advisor core and from the Phase 5 */
/* reference. It only computes the dealer's final total from the visible     */
/* cards, an unknown hole, and future draws. The hole is never supplied.     */
/* ------------------------------------------------------------------------- */

function dealerDistribution(playerRanks, upRank) {
  const counts = BASE.slice();
  for (const rank of playerRanks) counts[rank]--;
  counts[upRank]--;

  const memo = new Map();
  let n = counts.reduce((sum, c) => sum + c, 0);

  function terminal(total) {
    const p = new Float64Array(6);
    if (total >= 17 && total <= 21) p[total - 17] = 1;
    else p[5] = 1;
    return p;
  }

  function final(total, soft, remCode, remaining) {
    if (total >= 17) return terminal(total);
    if (!remaining) throw new Error('dealer exhausted the deck below 17');
    const key = `${remCode}:${total}:${soft ? 1 : 0}`;
    if (memo.has(key)) return memo.get(key);

    const out = new Float64Array(6);
    for (let rank = 0; rank < 10; rank++) {
      const c = counts[rank];
      if (!c) continue;
      const p = c / remaining;
      counts[rank]--;
      const next = solver.addRank(total, soft, rank);
      const sub = next.total >= 17
        ? terminal(next.total)
        : final(next.total, next.soft, remCode - solver.WEIGHTS[rank], remaining - 1);
      for (let i = 0; i < 6; i++) out[i] += p * sub[i];
      counts[rank]++;
    }
    memo.set(key, out);
    return out;
  }

  const out = new Float64Array(6);
  const up0 = solver.addRank(0, false, upRank);
  for (let rank = 0; rank < 10; rank++) {
    const c = counts[rank];
    if (!c) continue;
    const p = c / n;
    counts[rank]--;
    const next = solver.addRank(up0.total, up0.soft, rank);
    const sub = next.total >= 17
      ? terminal(next.total)
      : final(
        next.total,
        next.soft,
        solver.encodeCounts(counts),
        n - 1
      );
    for (let i = 0; i < 6; i++) out[i] += p * sub[i];
    counts[rank]++;
  }

  return { distribution: out, remaining: n };
}

function standEVFromDistribution(playerTotal, dist) {
  let ev = 0;
  let ev2 = 0;
  for (let i = 0; i < 5; i++) {
    const dealerTotal = 17 + i;
    const p = dist[i];
    if (!p) continue;
    if (playerTotal > dealerTotal) {
      ev += p;
      ev2 += p;
    } else if (playerTotal < dealerTotal) {
      ev -= p;
      ev2 += p;
    }
  }
  ev += dist[5];
  ev2 += dist[5];
  return { ev, ev2 };
}

function checkDealerDistribution(label, player, up) {
  const { distribution } = dealerDistribution(player, up);
  const sum = Array.from(distribution).reduce((a, b) => a + b, 0);
  assertClose(`${label} dealer probabilities sum`, sum, 1, 1e-12);
  for (let i = 0; i < 6; i++) {
    if (distribution[i] < -1e-15) fail(`${label} dealer probability ${i} is negative`);
  }
  return distribution;
}

/* ------------------------------------------------------------------------- */
/* 1. EV and settlement-rule audit.                                          */
/* ------------------------------------------------------------------------- */

let ruleChecks = 0;

function checkStandRule(label, player, up) {
  const dist = checkDealerDistribution(label, player, up);
  const actual = advisor.evaluate(player, up);
  const expected = standEVFromDistribution(actual.total, dist);
  assertClose(`${label} displayed stand EV`, actual.standEV, expected.ev);
  ruleChecks++;
}

function checkBustPushRule(label, player, up) {
  const dist = checkDealerDistribution(label, player, up);
  const actual = advisor.evaluate(player, up);
  assertEqual(`${label} should be bust`, actual.bust, true);
  assertEqual(`${label} should have no action`, actual.action, null);
  assertClose(`${label} bust EV should be dealerBust - 1`, actual.ev, dist[5] - 1);
  assertClose(`${label} bust second moment`, actual.ev2, 1 - dist[5]);
  ruleChecks++;
}

const rules = [
  { label: '20 vs 6', player: [9, 9], up: 5 },
  { label: '21 vs 6', player: [0, 9], up: 5 },
  { label: 'hard 12 vs 6', player: [5, 5], up: 5 },
  { label: 'soft 18 vs 9', player: [0, 6], up: 8 },
];
for (const row of rules) checkStandRule(row.label, row.player, row.up);

checkBustPushRule('bust 26 vs 9', [9, 9, 5], 8);

const natural = advisor.evaluate([0, 9], 5);
assertEqual('natural 21 total', natural.total, 21);
assertEqual('natural 21 is soft', natural.soft, true);
if (natural.standEV > 1 + 1e-12) fail('natural 21 appears to receive a 3:2 bonus');
if (natural.standEV < -1 - 1e-12) fail('natural 21 stand EV is below -1');
ruleChecks++;

const push = advisor.evaluate([9, 9, 5], 8);
const loss = lossReference([9, 9, 5], 8);
assertClose('both-bust push differs from both-bust loss by dealer bust probability',
  push.ev, loss.ev + push.dealerBust);
assertClose('both-bust loss is -1 when player is already bust', loss.ev, -1);
ruleChecks++;

/* ------------------------------------------------------------------------- */
/* 2. Card-entry validation.                                                 */
/* ------------------------------------------------------------------------- */

const cardChecks = [];

function expectThrow(label, fn, expectedPattern) {
  try {
    fn();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (expectedPattern && !expectedPattern.test(message)) {
      fail(`${label}: error message "${message}" did not match ${expectedPattern}`);
    }
    cardChecks.push({ label, result: 'rejected', message });
    return;
  }
  fail(`${label}: expected the advisor to reject this input`);
}

function expectAccepted(label, fn, predicate) {
  let value;
  try {
    value = fn();
  } catch (err) {
    fail(`${label}: expected acceptance, got error: ${err.message}`);
  }
  if (predicate && !predicate(value)) fail(`${label}: accepted with unexpected result`);
  cardChecks.push({ label, result: 'accepted' });
  return value;
}

expectThrow('no player cards', () => advisor.evaluate([], 0), /at least two/i);
expectThrow('one player card', () => advisor.evaluate([9], 0), /at least two/i);
expectThrow('missing upcard', () => advisor.evaluate([9, 9], null), /upcard/i);
expectThrow('upcard 10 (out of range)', () => advisor.evaluate([9, 9], 10), /upcard/i);
expectThrow('negative upcard', () => advisor.evaluate([9, 9], -1), /upcard/i);
expectThrow('fractional upcard', () => advisor.evaluate([9, 9], 0.5), /upcard/i);
expectThrow('string player rank', () => advisor.evaluate([9, '10'], 0), /invalid player card/i);
expectThrow('fractional player rank', () => advisor.evaluate([9, 9.5], 0), /invalid player card/i);
expectThrow('five aces', () => advisor.evaluate([0, 0, 0, 0, 0], 5), /not available/i);
expectThrow('four sevens', () => advisor.evaluate([6, 6, 6, 6], 0), /not available/i);
expectThrow('too many ten-value cards', () => advisor.evaluate([
  9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
], 0), /not available/i);
expectThrow('upcard conflicts with four player aces', () => advisor.evaluate([0, 0, 0, 0], 0), /upcard.*not available|not available/i);

const duplicateTens = expectAccepted('duplicate ten-value cards are legal until the deck count is exhausted',
  () => advisor.evaluate([9, 9, 0], 2), (r) => r.total === 21);
assertEqual('duplicate tens total', duplicateTens.total, 21);

const tripleSeven = expectAccepted('three sevens are legal',
  () => advisor.evaluate([6, 6, 6], 2), (r) => r.total === 21);
assertEqual('triple seven total', tripleSeven.total, 21);

const fourAces = expectAccepted('four aces are legal',
  () => advisor.evaluate([0, 0, 0, 0, 5], 9), (r) => r.total === 20 && r.soft === true);
assertEqual('four-ace total', fourAces.total, 20);
assertEqual('four-ace soft total', fourAces.soft, true);

expectAccepted('two aces are legal',
  () => advisor.evaluate([0, 0], 9), (r) => r.total === 12 && r.soft === true);

if (advisor.evaluate.length !== 2) {
  fail('advisor core unexpectedly accepts more than player cards and upcard');
}

/* ------------------------------------------------------------------------- */
/* 3. Random exact cross-check: 100,000 reachable visible states.            */
/* ------------------------------------------------------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawRank(counts, n, rng) {
  let target = Math.floor(rng() * n);
  for (let rank = 0; rank < 10; rank++) {
    if (target < counts[rank]) {
      counts[rank]--;
      return rank;
    }
    target -= counts[rank];
  }
  throw new Error('drawRank failed');
}

function randomState(rng) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const counts = BASE.slice();
    let n = counts.reduce((sum, c) => sum + c, 0);
    const up = drawRank(counts, n, rng);
    n--;
    const targetCards = 2 + Math.floor(rng() * 5);
    const player = [];
    let pv = { total: 0, soft: false };
    for (let i = 0; i < targetCards; i++) {
      const rank = drawRank(counts, n, rng);
      n--;
      player.push(rank);
      pv = solver.addRank(pv.total, pv.soft, rank);
      if (pv.total > 21) break;
    }
    if (player.length >= 2 && pv.total <= 21) {
      return { player, up, total: pv.total, soft: pv.soft };
    }
  }
  throw new Error('could not generate a non-bust state');
}

const args = process.argv.slice(2);
const statesIndex = args.indexOf('--states');
const stateCount = statesIndex >= 0 ? parseInt(args[statesIndex + 1], 10) : 100000;
if (!Number.isInteger(stateCount) || stateCount < 1) {
  fail('usage: node phase7-audit.js [--states N]');
}

const rng = mulberry32(0x5EED2027);
let actionMismatches = 0;
let evMismatches = 0;
let totalSoftMismatches = 0;
let ev2Mismatches = 0;
const examples = [];
const started = Date.now();

for (let i = 0; i < stateCount; i++) {
  const state = randomState(rng);
  let expected;
  let actual;
  try {
    expected = reference(state.player, state.up);
    actual = advisor.evaluate(state.player, state.up);
  } catch (err) {
    fail(`evaluation error for ${state.player.join(',')} vs ${state.up}: ${err.message}`);
  }

  const evOk = close(expected.standEV, actual.standEV)
    && close(expected.hitEV, actual.hitEV)
    && close(expected.ev, actual.ev);
  const ev2Ok = close(expected.ev2, actual.ev2);
  const totalSoftOk = expected.total === actual.total && expected.soft === actual.soft;
  if (expected.action !== actual.action) actionMismatches++;
  if (!evOk) evMismatches++;
  if (!totalSoftOk) totalSoftMismatches++;
  if (!ev2Ok) ev2Mismatches++;

  if ((!evOk || !ev2Ok || !totalSoftOk || expected.action !== actual.action) && examples.length < 5) {
    examples.push({
      player: state.player.map((r) => solver.RANKS[r]).join(' '),
      up: solver.RANKS[state.up],
      expected: {
        action: expected.action,
        standEV: expected.standEV,
        hitEV: expected.hitEV,
        ev: expected.ev,
        ev2: expected.ev2,
        total: expected.total,
        soft: expected.soft,
      },
      actual: {
        action: actual.action,
        standEV: actual.standEV,
        hitEV: actual.hitEV,
        ev: actual.ev,
        ev2: actual.ev2,
        total: actual.total,
        soft: actual.soft,
      },
    });
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(2);
const totalMismatches = actionMismatches + evMismatches + totalSoftMismatches + ev2Mismatches;

/* ------------------------------------------------------------------------- */
/* 4. Privacy / offline static checks.                                       */
/* ------------------------------------------------------------------------- */

const privacyPatterns = [
  ['external URL', /https?:\/\//i],
  ['external script src', /<script[^>]+\bsrc\s*=/i],
  ['external link href', /<link[^>]+\bhref\s*=/i],
  ['CSS @import', /@import/i],
  ['fetch()', /\bfetch\s*\(/i],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/i],
  ['navigator.sendBeacon', /sendBeacon/i],
  ['WebSocket', /\bWebSocket\b/i],
  ['EventSource', /\bEventSource\b/i],
  ['localStorage', /\blocalStorage\b/i],
  ['sessionStorage', /\bsessionStorage\b/i],
  ['indexedDB', /\bindexedDB\b/i],
  ['document.cookie', /document\.cookie/i],
  ['form element', /<form\b/i],
  ['input element', /<input\b/i],
  ['textarea element', /<textarea\b/i],
  ['remote CSS url()', /url\(\s*['"]?https?:/i],
];
const privacyViolations = privacyPatterns
  .filter(([, pattern]) => pattern.test(html))
  .map(([label]) => label);

if (privacyViolations.length) {
  fail(`privacy/offline static check found: ${privacyViolations.join(', ')}`);
}

// The UI scripts must parse even though they cannot run without a DOM.
const scriptMatches = [...html.matchAll(/<script(?:\s+id="[^"]+")?>([\s\S]*?)<\/script>/g)];
if (scriptMatches.length !== 2) fail(`expected two inline scripts, found ${scriptMatches.length}`);
for (const match of scriptMatches) {
  try {
    new Function(match[1]); // syntax-only check
  } catch (err) {
    fail(`inline script syntax error: ${err.message}`);
  }
}

/* ------------------------------------------------------------------------- */
/* Output.                                                                   */
/* ------------------------------------------------------------------------- */

console.log('PHASE 7 ADVISOR AUDIT');
console.log('');
console.log('[1] EV and settlement rules');
console.log('  Stand EV: player total vs dealer 17-21, dealer bust counts as a win.');
console.log('  Hit EV: weighted over every legal draw, with optimal continuation.');
console.log('  Win/push/loss: +1 / 0 / -1; no 3:2 natural bonus.');
console.log('  Player bust: dealer bust => push (0), dealer non-bust => loss (-1).');
console.log(`  Rule-level checks passed: ${ruleChecks}`);
console.log('  Natural 21 does not receive a 3:2 payout.');
console.log('  Both-bust push is exactly one dealer-bust probability better than both-bust loss.');
console.log('');
console.log('[2] Card entry and validation');
console.log('  Duplicate ten-value cards accepted within the 16-card limit.');
console.log('  Three sevens accepted; a fourth seven rejected.');
console.log('  Multiple aces accepted; a fifth ace rejected.');
console.log('  Invalid ranks, invalid upcards, missing input, and deck conflicts rejected.');
console.log(`  Card-entry checks passed: ${cardChecks.length}`);
console.log('');
console.log('[3] Exact cross-check');
console.log(`  States: ${stateCount.toLocaleString()} random reachable visible states`);
console.log('  Cards: 2-6 player cards, one upcard, total <= 21; hole never supplied');
console.log('  Seed: 0x5EED2027');
console.log(`  Action mismatches: ${actionMismatches}`);
console.log(`  EV mismatches: ${evMismatches}`);
console.log(`  Total/soft mismatches: ${totalSoftMismatches}`);
console.log(`  EV2 mismatches: ${ev2Mismatches}`);
console.log(`  Total mismatches: ${totalMismatches}`);
console.log(`  Elapsed: ${seconds}s`);
if (examples.length) {
  console.log('  First mismatches:');
  for (const example of examples) console.log(`  ${JSON.stringify(example)}`);
}
console.log('');
console.log('[4] Privacy and offline checks');
console.log('  No external URL, script src, stylesheet href, CSS import, or remote CSS URL.');
console.log('  No fetch, XMLHttpRequest, sendBeacon, WebSocket, or EventSource.');
console.log('  No localStorage, sessionStorage, indexedDB, or document.cookie.');
console.log('  No form, input, or textarea elements; no hole-card field.');
console.log('  Both inline scripts parse.');
console.log('');

if (totalMismatches) {
  fail('the advisor did not match the exact solver');
}
if (privacyViolations.length) {
  fail('privacy/offline static check failed');
}
console.log('  RESULT: PASS. Advisor matches the exact solver on every tested state.');
