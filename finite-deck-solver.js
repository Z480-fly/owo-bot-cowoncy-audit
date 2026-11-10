#!/usr/bin/env node
/*
 * Exact finite-deck blackjack solver for the published OwO rules.
 *
 * Public source audited:
 *   ChristopherBThai/Discord-OwO-Bot @ 9aec92b274bae64ea078fc04540398713e7f7928
 *
 * The published command builds a fresh 51-card deck for each game. This solver
 * evaluates every reachable player state with the actual remaining rank
 * composition, the hidden dealer hole card, and the published both-bust rule.
 *
 * It is completely offline. It does not contact OwO, Discord, MariaDB, Redis,
 * or any live service.
 */
'use strict';

const crypto = require('crypto');

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T'];
const RADICES = [5, 5, 5, 5, 5, 5, 4, 5, 5, 17];
const WEIGHTS = new Array(10);
WEIGHTS[0] = 1;
for (let i = 1; i < 10; i++) WEIGHTS[i] = WEIGHTS[i - 1] * RADICES[i - 1];

const BASE_51 = [4, 4, 4, 4, 4, 4, 3, 4, 4, 16];
const BASE_52 = [4, 4, 4, 4, 4, 4, 4, 4, 4, 16];

const VARIANTS = {
  '51-push': { label: 'Published 51-card deck; both bust pushes', counts: BASE_51, bothBust: 'push' },
  '52-push': { label: 'Corrected 52-card deck; both bust pushes', counts: BASE_52, bothBust: 'push' },
  '51-loss': { label: 'Published 51-card deck; both bust loses', counts: BASE_51, bothBust: 'loss' },
  '52-loss': { label: 'Corrected 52-card deck; both bust loses', counts: BASE_52, bothBust: 'loss' },
};

function addRank(total, soft, rank) {
  if (rank === 0) {
    if (total + 11 <= 21) return { total: total + 11, soft: true };
    let next = total + 1;
    if (next > 21 && soft) {
      next -= 10;
      soft = false;
    }
    return { total: next, soft: soft && next <= 21 };
  }
  const value = rank + 1;
  let next = total + value;
  if (next > 21 && soft) {
    next -= 10;
    soft = false;
  }
  return { total: next, soft: soft && next <= 21 };
}

function encodeCounts(counts) {
  let code = 0;
  for (let i = 0; i < 10; i++) code += counts[i] * WEIGHTS[i];
  return code;
}

function decodeCounts(code) {
  const out = new Array(10);
  for (let i = 0; i < 10; i++) {
    out[i] = Math.floor(code / WEIGHTS[i]) % RADICES[i];
  }
  return out;
}

function sumCounts(counts) {
  let n = 0;
  for (let i = 0; i < 10; i++) n += counts[i];
  return n;
}

function terminalDistribution(total) {
  const p = new Float64Array(6);
  if (total >= 17 && total <= 21) p[total - 17] = 1;
  else p[5] = 1;
  return p;
}

function upValue(rank) {
  return rank === 0 ? 11 : rank === 9 ? 10 : rank + 1;
}

/*
 * Infinite-deck table used by blackjack-simulator.js. This is the policy we
 * compare against; it is not the exact policy.
 */
function basicAction(total, soft, upRank) {
  if (soft) {
    if (total >= 19) return 'stand';
    if (total === 18) return upRank === 0 || upRank >= 8 ? 'hit' : 'stand'; // A, 9, T
    return 'hit';
  }
  if (total >= 18) return 'stand';
  if (total === 17) return upRank >= 1 && upRank <= 6 ? 'stand' : 'hit'; // 2..7
  if (total === 16) return upRank === 4 || upRank === 5 ? 'stand' : 'hit'; // 5,6
  return 'hit';
}

function makeContext(variantKey) {
  const variant = VARIANTS[variantKey];
  if (!variant) throw new Error(`unknown variant: ${variantKey}`);
  return {
    key: variantKey,
    variant,
    dealerFinalMemo: new Map(),
    dealerInitialMemo: new Map(),
    playerMemos: Array.from({ length: 10 }, () => new Map()),
    policyMemos: Array.from({ length: 10 }, () => new Map()),
    stats: {
      dealerFinalStates: 0,
      dealerInitialStates: 0,
      playerStates: 0,
      policyStates: 0,
      policyDeviations: 0,
    },
  };
}

function dealerFinal(ctx, remCode, total, soft, counts, n) {
  if (total >= 17) return terminalDistribution(total);
  if (n === 0) throw new Error('dealer ran out of cards below 17');
  const stateCode = total * 2 + (soft ? 1 : 0);
  const key = remCode * 64 + stateCode;
  const cached = ctx.dealerFinalMemo.get(key);
  if (cached) return cached;

  const out = new Float64Array(6);
  for (let rank = 0; rank < 10; rank++) {
    const c = counts[rank];
    if (!c) continue;
    const p = c / n;
    counts[rank] = c - 1;
    const next = addRank(total, soft, rank);
    const sub = next.total >= 17
      ? terminalDistribution(next.total)
      : dealerFinal(ctx, remCode - WEIGHTS[rank], next.total, next.soft, counts, n - 1);
    for (let i = 0; i < 6; i++) out[i] += p * sub[i];
    counts[rank] = c;
  }
  ctx.dealerFinalMemo.set(key, out);
  ctx.stats.dealerFinalStates++;
  return out;
}

function dealerInitial(ctx, remCode, upRank, counts, n) {
  const key = remCode * 10 + upRank;
  const cached = ctx.dealerInitialMemo.get(key);
  if (cached) return cached;
  if (n === 0) throw new Error('no hole card available');

  const out = new Float64Array(6);
  const up0 = addRank(0, false, upRank);
  for (let rank = 0; rank < 10; rank++) {
    const c = counts[rank];
    if (!c) continue;
    const p = c / n;
    counts[rank] = c - 1;
    const next = addRank(up0.total, up0.soft, rank);
    const sub = next.total >= 17
      ? terminalDistribution(next.total)
      : dealerFinal(ctx, remCode - WEIGHTS[rank], next.total, next.soft, counts, n - 1);
    for (let i = 0; i < 6; i++) out[i] += p * sub[i];
    counts[rank] = c;
  }
  ctx.dealerInitialMemo.set(key, out);
  ctx.stats.dealerInitialStates++;
  return out;
}

function standMoments(ctx, remCode, playerTotal, upRank, counts, n) {
  const dist = dealerInitial(ctx, remCode, upRank, counts, n);
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
    // equal is a tie: 0
  }
  // dealer bust is a player win when the player is not bust
  ev += dist[5];
  ev2 += dist[5];
  return { ev, ev2 };
}

function bustMoments(ctx, remCode, upRank, counts, n) {
  const dist = dealerInitial(ctx, remCode, upRank, counts, n);
  const dealerBust = dist[5];
  if (ctx.variant.bothBust === 'push') {
    // dealer bust -> tie 0; dealer non-bust -> loss -1
    return { ev: dealerBust - 1, ev2: 1 - dealerBust };
  }
  return { ev: -1, ev2: 1 };
}

function playerKey(remCode, total, soft) {
  return remCode * 64 + total * 2 + (soft ? 1 : 0);
}

function optimalMoments(ctx, remCode, total, soft, upRank, counts, n) {
  const key = playerKey(remCode, total, soft);
  const memo = ctx.playerMemos[upRank];
  const cached = memo.get(key);
  if (cached) return cached;

  const stand = standMoments(ctx, remCode, total, upRank, counts, n);
  let hitEv = 0;
  let hitEv2 = 0;
  for (let rank = 0; rank < 10; rank++) {
    const c = counts[rank];
    if (!c) continue;
    const p = c / n;
    counts[rank] = c - 1;
    const next = addRank(total, soft, rank);
    let sub;
    if (next.total > 21) {
      sub = bustMoments(ctx, remCode - WEIGHTS[rank], upRank, counts, n - 1);
    } else {
      sub = optimalMoments(ctx, remCode - WEIGHTS[rank], next.total, next.soft, upRank, counts, n - 1);
    }
    hitEv += p * sub.ev;
    hitEv2 += p * sub.ev2;
    counts[rank] = c;
  }

  const chooseHit = hitEv > stand.ev;
  const ev = chooseHit ? hitEv : stand.ev;
  const ev2 = chooseHit ? hitEv2 : stand.ev2;
  const action = chooseHit ? 'hit' : 'stand';
  const result = { standEV: stand.ev, hitEV: hitEv, action, ev, ev2 };
  memo.set(key, result);
  ctx.stats.playerStates++;
  return result;
}

function policyMoments(ctx, remCode, total, soft, upRank, counts, n) {
  const key = playerKey(remCode, total, soft);
  const memo = ctx.policyMemos[upRank];
  const cached = memo.get(key);
  if (cached) return cached;

  const action = basicAction(total, soft, upRank);
  let ev;
  let ev2;
  if (action === 'stand') {
    const m = standMoments(ctx, remCode, total, upRank, counts, n);
    ev = m.ev;
    ev2 = m.ev2;
  } else {
    ev = 0;
    ev2 = 0;
    for (let rank = 0; rank < 10; rank++) {
      const c = counts[rank];
      if (!c) continue;
      const p = c / n;
      counts[rank] = c - 1;
      const next = addRank(total, soft, rank);
      const sub = next.total > 21
        ? bustMoments(ctx, remCode - WEIGHTS[rank], upRank, counts, n - 1)
        : policyMoments(ctx, remCode - WEIGHTS[rank], next.total, next.soft, upRank, counts, n - 1);
      ev += p * sub.ev;
      ev2 += p * sub.ev2;
      counts[rank] = c;
    }
  }

  const exact = optimalMoments(ctx, remCode, total, soft, upRank, counts, n);
  if (action !== exact.action) ctx.stats.policyDeviations++;
  const result = { action, ev, ev2 };
  memo.set(key, result);
  ctx.stats.policyStates++;
  return result;
}

function initialStates(baseCounts) {
  const out = [];
  const baseTotal = sumCounts(baseCounts);
  for (let a = 0; a < 10; a++) {
    for (let b = a; b < 10; b++) {
      const pairWays = a === b
        ? (baseCounts[a] * (baseCounts[a] - 1)) / 2
        : baseCounts[a] * baseCounts[b];
      if (!pairWays) continue;
      const pair = addRank(0, false, a);
      const player = addRank(pair.total, pair.soft, b);
      for (let up = 0; up < 10; up++) {
        let upWays = baseCounts[up];
        if (a === up) upWays--;
        if (b === up) upWays--;
        if (upWays <= 0) continue;

        const counts = baseCounts.slice();
        counts[a]--;
        counts[b]--;
        counts[up]--;
        if (counts[a] < 0 || counts[b] < 0 || counts[up] < 0) continue;

        const remCode = encodeCounts(counts);
        out.push({
          a,
          b,
          up,
          label: RANKS[a] + RANKS[b],
          total: player.total,
          soft: player.soft,
          pairWays,
          upWays,
          weight: pairWays * upWays,
          remCode,
          counts,
          n: baseTotal - 3,
        });
      }
    }
  }
  return out;
}

function evaluateVisibleWithContext(ctx, playerRanks, upRank) {
  const counts = ctx.variant.counts.slice();
  let pv = { total: 0, soft: false };
  for (const rank of playerRanks) {
    if (!Number.isInteger(rank) || rank < 0 || rank > 9) throw new Error(`invalid player rank: ${rank}`);
    if (counts[rank] <= 0) throw new Error(`too many cards of rank ${rank}`);
    counts[rank]--;
    pv = addRank(pv.total, pv.soft, rank);
  }
  if (!Number.isInteger(upRank) || upRank < 0 || upRank > 9) throw new Error(`invalid upcard rank: ${upRank}`);
  if (counts[upRank] <= 0) throw new Error(`too many cards of upcard rank ${upRank}`);
  counts[upRank]--;
  const n = sumCounts(counts);
  const remCode = encodeCounts(counts);
  if (pv.total > 21) {
    const bust = bustMoments(ctx, remCode, upRank, counts, n);
    return { total: pv.total, soft: pv.soft, bust: true, action: null, standEV: null, hitEV: null, ev: bust.ev, ev2: bust.ev2 };
  }
  const exact = optimalMoments(ctx, remCode, pv.total, pv.soft, upRank, counts, n);
  return {
    total: pv.total,
    soft: pv.soft,
    bust: false,
    action: exact.action,
    standEV: exact.standEV,
    hitEV: exact.hitEV,
    ev: exact.ev,
    ev2: exact.ev2,
  };
}

function createVisibleEvaluator(variantKey) {
  const ctx = makeContext(variantKey);
  return (playerRanks, upRank) => evaluateVisibleWithContext(ctx, playerRanks, upRank);
}

function evaluateVisibleState(variantKey, playerRanks, upRank) {
  return createVisibleEvaluator(variantKey)(playerRanks, upRank);
}

function runVariant(variantKey, options = {}) {
  const ctx = makeContext(variantKey);
  const baseCounts = ctx.variant.counts.slice();
  const baseTotal = sumCounts(baseCounts);
  const states = initialStates(baseCounts);
  const rows = [];
  let totalWays = 0;
  let aggregateEv = 0;
  let aggregateEv2 = 0;
  let basicEv = 0;
  let basicEv2 = 0;
  let exactWinsVsBasic = 0;
  let exactLossesVsBasic = 0;
  let exactTiesVsBasic = 0;

  for (const s of states) {
    totalWays += s.weight;
    const exact = optimalMoments(ctx, s.remCode, s.total, s.soft, s.up, s.counts, s.n);
    const basic = policyMoments(ctx, s.remCode, s.total, s.soft, s.up, s.counts, s.n);
    aggregateEv += s.weight * exact.ev;
    aggregateEv2 += s.weight * exact.ev2;
    basicEv += s.weight * basic.ev;
    basicEv2 += s.weight * basic.ev2;
    if (exact.action !== basic.action) {
      if (exact.ev > basic.ev + 1e-12) exactWinsVsBasic++;
      else if (exact.ev < basic.ev - 1e-12) exactLossesVsBasic++;
      else exactTiesVsBasic++;
    }
    rows.push({ ...s, exact, basic });
  }

  if (!totalWays) throw new Error('no initial states');
  const exactMean = aggregateEv / totalWays;
  const exactSecond = aggregateEv2 / totalWays;
  const exactSd = Math.sqrt(Math.max(0, exactSecond - exactMean * exactMean));
  const basicMean = basicEv / totalWays;
  const basicSecond = basicEv2 / totalWays;
  const basicSd = Math.sqrt(Math.max(0, basicSecond - basicMean * basicMean));
  const differences = rows
    .filter((r) => r.exact.action !== r.basic.action)
    .sort((x, y) => (x.up - y.up) || (x.a - y.a) || (x.b - y.b));

  // Compare the exact action with the infinite table in every reachable
  // exact state, not only the 550 initial states.
  let allStateDeviations = 0;
  for (let up = 0; up < 10; up++) {
    for (const [key, result] of ctx.playerMemos[up]) {
      const state = key % 64;
      const total = Math.floor(state / 2);
      const soft = (state % 2) === 1;
      if (basicAction(total, soft, up) !== result.action) allStateDeviations++;
    }
  }

  const summary = {
    key: variantKey,
    label: ctx.variant.label,
    baseTotal,
    totalWays,
    exactMean,
    exactSd,
    exactRtp: 1 + exactMean,
    basicMean,
    basicSd,
    basicRtp: 1 + basicMean,
    improvement: exactMean - basicMean,
    exactWinsVsBasic,
    exactLossesVsBasic,
    exactTiesVsBasic,
    states: rows.length,
    dealerFinalStates: ctx.stats.dealerFinalStates,
    dealerInitialStates: ctx.stats.dealerInitialStates,
    playerStates: ctx.stats.playerStates,
    policyStates: ctx.stats.policyStates,
    policyDeviations: ctx.stats.policyDeviations,
    allStateDeviations,
    rows,
    differences,
  };

  if (options.simGames) {
    summary.simulation = simulateVariant(ctx, exactMean, exactSd, options.simGames, options.seed || 1, true);
    summary.simulationBasic = simulateVariant(ctx, basicMean, basicSd, options.simGames, (options.seed || 1) + 1, false);
  }
  return summary;
}

/* ------------------------------------------------------------------------- */
/* Independent Monte Carlo validation                                        */
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

function visibleCode(drawCounts, holeRank) {
  const visible = drawCounts.slice();
  visible[holeRank]++;
  return encodeCounts(visible);
}

function addHole(counts, holeRank) {
  const visible = counts.slice();
  visible[holeRank]++;
  return visible;
}

function playExactHand(ctx, useExact, rng) {
  const base = ctx.variant.counts.slice();
  const total = sumCounts(base);
  const drawCounts = base.slice();

  const p1 = drawRank(drawCounts, total, rng);
  const p2 = drawRank(drawCounts, total - 1, rng);
  const up = drawRank(drawCounts, total - 2, rng);
  const hole = drawRank(drawCounts, total - 3, rng);

  let pv = addRank(0, false, p1);
  pv = addRank(pv.total, pv.soft, p2);
  let playerTotal = pv.total;
  let playerSoft = pv.soft;

  for (;;) {
    if (playerTotal > 21) break;
    const visible = addHole(drawCounts, hole);
    const code = encodeCounts(visible);
    const n = sumCounts(visible);
    const state = useExact
      ? optimalMoments(ctx, code, playerTotal, playerSoft, up, visible, n)
      : policyMoments(ctx, code, playerTotal, playerSoft, up, visible, n);
    if (state.action === 'stand') break;

    const card = drawRank(drawCounts, sumCounts(drawCounts), rng);
    const next = addRank(playerTotal, playerSoft, card);
    playerTotal = next.total;
    playerSoft = next.soft;
    if (playerTotal > 21) break;
  }

  // Dealer reveals the hole, then hits while below 17.
  let dv = addRank(0, false, up);
  dv = addRank(dv.total, dv.soft, hole);
  let dealerTotal = dv.total;
  let dealerSoft = dv.soft;
  while (dealerTotal < 17) {
    const card = drawRank(drawCounts, sumCounts(drawCounts), rng);
    const next = addRank(dealerTotal, dealerSoft, card);
    dealerTotal = next.total;
    dealerSoft = next.soft;
  }

  let result;
  if (playerTotal > 21 && dealerTotal > 21) {
    result = ctx.variant.bothBust === 'push' ? 'tie' : 'loss';
  } else if (playerTotal > 21) {
    result = 'loss';
  } else if (dealerTotal > 21) {
    result = 'win';
  } else if (playerTotal > dealerTotal) {
    result = 'win';
  } else if (playerTotal === dealerTotal) {
    result = 'tie';
  } else {
    result = 'loss';
  }
  return { result, playerTotal, dealerTotal };
}

function simulateVariant(ctx, exactMean, exactSd, games, seed, useExact = true) {
  const rng = mulberry32(seed);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let net = 0;
  let net2 = 0;
  for (let i = 0; i < games; i++) {
    const hand = playExactHand(ctx, useExact, rng);
    const x = hand.result === 'win' ? 1 : hand.result === 'loss' ? -1 : 0;
    if (x > 0) wins++;
    else if (x < 0) losses++;
    else ties++;
    net += x;
    net2 += x * x;
  }
  const mean = net / games;
  const variance = Math.max(0, (net2 - games * mean * mean) / (games - 1));
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(games);
  return {
    games,
    wins,
    losses,
    ties,
    mean,
    sd,
    se,
    ci95: [mean - 1.96 * se, mean + 1.96 * se],
    exactMean,
    exactSd,
    z: se ? (mean - exactMean) / se : 0,
  };
}

/* ------------------------------------------------------------------------- */
/* Output                                                                    */
/* ------------------------------------------------------------------------- */

function pct(x, digits = 4) {
  return `${(x * 100).toFixed(digits)}%`;
}

function fmt(x, digits = 6) {
  return Number(x).toFixed(digits);
}

function stateKeyLabel(row) {
  return `${row.label.padEnd(2)} total ${String(row.total).padStart(2)} ${row.soft ? 'soft' : 'hard'} up ${RANKS[row.up]}`;
}

function printSummary(summary) {
  console.log(`  ${summary.label}`);
  console.log(`    Initial states: ${summary.states} (weighted cases ${summary.totalWays.toLocaleString()})`);
  console.log(`    Exact EV/unit: ${fmt(summary.exactMean)}  exact SD: ${fmt(summary.exactSd)}  RTP: ${pct(summary.exactRtp, 4)}`);
  console.log(`    Basic EV/unit: ${fmt(summary.basicMean)}  basic SD: ${fmt(summary.basicSd)}  RTP: ${pct(summary.basicRtp, 4)}`);
  console.log(`    Exact improvement over basic: ${fmt(summary.improvement)} per unit (${pct(summary.improvement, 4)})`);
  console.log(`    Action differences at initial state: ${summary.differences.length} (${summary.exactWinsVsBasic} better, ${summary.exactLossesVsBasic} worse, ${summary.exactTiesVsBasic} equal EV)`);  console.log(`    Reachable player states evaluated: ${summary.playerStates.toLocaleString()}`);
    console.log(`    Exact-vs-basic action differences over all reachable states: ${summary.allStateDeviations.toLocaleString()}`);
    console.log(`    Dealer initial states: ${summary.dealerInitialStates.toLocaleString()}; dealer draw states: ${summary.dealerFinalStates.toLocaleString()}`);
  console.log('');
}

function printVariants(summaries) {
  console.log('EXACT VARIANT SUMMARY');
  console.log('  Variant        Deck  Rule        Exact EV/unit   Exact SD   RTP        Basic EV/unit   Improvement');
  for (const s of summaries) {
    const deck = s.baseTotal === 51 ? '51' : '52';
    const rule = s.key.endsWith('push') ? 'both push' : 'both loss';
    console.log(
      `  ${s.key.padEnd(13)} ${deck.padStart(4)}  ${rule.padEnd(10)}  ${fmt(s.exactMean, 6).padStart(12)}  ${fmt(s.exactSd, 6).padStart(8)}  ${pct(s.exactRtp, 4).padStart(9)}  ${fmt(s.basicMean, 6).padStart(14)}  ${fmt(s.improvement, 6).padStart(11)}`
    );
  }
  console.log('');
}

function printInitialTable(summary, showAll) {
  console.log(`INITIAL TWO-CARD EXACT ACTIONS — ${summary.key}`);
  console.log('  Action is the exact optimal first decision for the shown rank pair and dealer upcard.');
  console.log('  H=hit, S=stand. The solver continues with composition-dependent decisions after every hit.');
  console.log('');
  console.log('  Pair    2  3  4  5  6  7  8  9 10  A');
  const byPair = new Map();
  for (const r of summary.rows) {
    const key = r.label;
    if (!byPair.has(key)) byPair.set(key, new Map());
    byPair.get(key).set(r.up, r.exact.action);
  }
  for (const [label, actions] of byPair) {
    let line = `  ${label.padEnd(4)}  `;
    for (let u = 1; u < 10; u++) line += `${(actions.get(u) || '?')[0].toUpperCase()}  `;
    line += `${(actions.get(0) || '?')[0].toUpperCase()}`;
    console.log(line);
  }
  console.log('');
  if (showAll) {
    console.log('  FULL INITIAL STATE DETAIL');
    console.log('  Pair  Total  Up   Exact   Basic   StandEV    HitEV     ExactEV');
    for (const r of summary.rows.slice().sort((a, b) => (a.a - b.a) || (a.b - b.b) || (a.up - b.up))) {
      console.log(
        `  ${r.label.padEnd(4)}  ${String(r.total).padStart(5)}  ${RANKS[r.up].padStart(2)}   ${r.exact.action.padEnd(6)}  ${r.basic.action.padEnd(6)}  ${fmt(r.exact.standEV, 6).padStart(9)}  ${fmt(r.exact.hitEV, 6).padStart(9)}  ${fmt(r.exact.ev, 6).padStart(9)}`
      );
    }
    console.log('');
  }
}

function printDifferences(summary) {
  console.log(`INITIAL-STATE DIFFERENCES FROM INFINITE-DECK BASIC — ${summary.key}`);
  if (!summary.differences.length) {
    console.log('  None.');
    console.log('');
    return;
  }
  console.log('  Pair  Total  Up   Exact   Basic   ExactEV    BasicEV');
  for (const r of summary.differences) {
    console.log(
      `  ${r.label.padEnd(4)}  ${String(r.total).padStart(5)}  ${RANKS[r.up].padStart(2)}   ${r.exact.action.padEnd(6)}  ${r.basic.action.padEnd(6)}  ${fmt(r.exact.ev, 6).padStart(8)}  ${fmt(r.basic.ev, 6).padStart(8)}`
    );
  }
  console.log('');
}

function printSimulationSummary(summary, label, s) {
  console.log(`MONTE CARLO VALIDATION — ${summary.key} (${s.games.toLocaleString()} hands, ${label} policy)`);
  console.log(`  W/L/T: ${s.wins.toLocaleString()} / ${s.losses.toLocaleString()} / ${s.ties.toLocaleString()}`);
  console.log(`  Mean net/unit: ${fmt(s.mean)}  sample SD: ${fmt(s.sd)}  SE: ${fmt(s.se)}`);
  console.log(`  95% CI: [${fmt(s.ci95[0])}, ${fmt(s.ci95[1])}]  exact EV: ${fmt(s.exactMean)}  z=${fmt(s.z, 3)}`);
  console.log(`  Exact SD: ${fmt(s.exactSd)}  ${Math.abs(s.z) < 2.5 ? 'AGREES within 2.5 SE' : 'CHECK: outside 2.5 SE'}`);
  console.log('');
}

function printSimulation(summary) {
  if (summary.simulation) printSimulationSummary(summary, 'exact', summary.simulation);
  if (summary.simulationBasic) printSimulationSummary(summary, 'basic', summary.simulationBasic);
}

function main() {
  const args = process.argv.slice(2);
  const get = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
  };
  const variants = get('--variant', 'all') === 'all'
    ? Object.keys(VARIANTS)
    : [get('--variant')];
  const simGames = parseInt(get('--sim-games', '0'), 10);
  const seed = parseInt(get('--seed', '1'), 10);
  const showAll = args.includes('--all-initial');
  const onlyInitial = args.includes('--initial-only');

  console.log('='.repeat(78));
  console.log('OWO EXACT FINITE-DECK BLACKJACK SOLVER');
  console.log('='.repeat(78));
  console.log('Source: 9aec92b274bae64ea078fc04540398713e7f7928');
  console.log('Offline only; no live OwO/Discord/database access.');
  console.log('Deck lifecycle in public source: module-level 51-card array -> deck.slice(0) per game');
  console.log('  -> randCard splice with removal -> initDeck removes all known cards for hits/stop.');
  console.log('  The original deck array is never mutated; every game resets to 51 cards.');
  console.log('  Cards are removed only within the hand, not across games.');
  console.log('');

  const summaries = [];
  for (const key of variants) {
    if (!VARIANTS[key]) throw new Error(`unknown variant: ${key}`);
    console.log('-'.repeat(78));
    console.log(`SOLVING ${key}: ${VARIANTS[key].label}`);
    console.log('-'.repeat(78));
    const started = Date.now();
    const summary = runVariant(key, { simGames, seed });
    console.log(`  Solve time: ${((Date.now() - started) / 1000).toFixed(2)}s`);
    printSummary(summary);
    if (!onlyInitial) {
      printInitialTable(summary, showAll && summaries.length === 0);
      printDifferences(summary);
    }
    if (simGames) printSimulation(summary);
    summaries.push(summary);
  }

  if (summaries.length > 1) {
    console.log('-'.repeat(78));
    printVariants(summaries);
  } else {
    printVariants(summaries);
  }

  console.log('LEGEND / EVIDENCE');
  console.log('  EV/unit: +1 win, 0 tie, -1 loss. RTP = 1 + EV/unit.');
  console.log('  Exact EV is a dynamic-programming result over remaining rank counts, not a simulation.');
  console.log('  Monte Carlo is an independent check of the same policy and rules.');
  console.log('  The exact policy is composition-dependent after every hit; the printed initial table is');
  console.log('  only the first decision. The solver evaluates all reachable states internally.');
  console.log('');
}

if (require.main === module) main();

module.exports = {
  RANKS,
  WEIGHTS,
  BASE_51,
  BASE_52,
  VARIANTS,
  addRank,
  encodeCounts,
  decodeCounts,
  basicAction,
  createVisibleEvaluator,
  evaluateVisibleState,
  runVariant,
  simulateVariant,
};
