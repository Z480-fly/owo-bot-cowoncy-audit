#!/usr/bin/env node
'use strict';

/**
 * Interactive / one-shot blackjack advisor using the exact finite-deck solver
 * from the owo-bot-cowoncy-audit repo (51-card published rules, both-bust = push).
 *
 * Usage:
 *   node bj-helper.js "10 6" 9
 *   node bj-helper.js "A 7" 6
 *   node bj-helper.js "A A 8" T
 *
 * Ranks: A, 2-9, T/10/J/Q/K
 */

const { createVisibleEvaluator } = require('./finite-deck-solver');

const evaluateVisible = createVisibleEvaluator('51-push');

const RANK_MAP = {
  A: 0, a: 0,
  '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7, '9': 8,
  T: 9, t: 9, '10': 9, J: 9, j: 9, Q: 9, q: 9, K: 9, k: 9,
};

const RANK_LABELS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

function parseRank(token) {
  const r = RANK_MAP[token];
  if (r === undefined) throw new Error(`Unknown rank: "${token}"`);
  return r;
}

function parseHand(str) {
  return str.trim().split(/[\s,]+/).filter(Boolean).map(parseRank);
}

function formatEV(v) {
  if (!Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(4);
}

function advise(playerRanks, dealerUpRank) {
  if (playerRanks.length < 2) throw new Error('Need at least 2 player cards');
  if (dealerUpRank < 0 || dealerUpRank > 9) throw new Error('Invalid dealer upcard');

  const result = evaluateVisible(playerRanks.slice(), dealerUpRank);

  const action = result.bust ? 'BUST' : result.action === 'hit' ? 'HIT' : 'STAND';
  const totalLabel = (result.soft ? 'Soft ' : 'Hard ') + result.total;

  return {
    action,
    totalLabel,
    standEV: result.standEV,
    hitEV: result.hitEV,
    bestEV: result.ev,
    bust: result.bust,
    player: playerRanks.map(r => RANK_LABELS[r]).join(', '),
    dealer: RANK_LABELS[dealerUpRank],
  };
}

function printAdvice(a) {
  console.log('');
  if (a.bust) {
    console.log(`  # BUST`);
    console.log(`  ${a.totalLabel} vs dealer ${a.dealer}`);
    console.log(`  Settlement EV: ${formatEV(a.bestEV)}`);
  } else {
    console.log(`  # ${a.action}`);
    console.log(`  ${a.totalLabel} vs dealer ${a.dealer}`);
    console.log(`  Stand EV: ${formatEV(a.standEV)}`);
    console.log(`  Hit   EV: ${formatEV(a.hitEV)}`);
  }
  console.log(`  Known cards: player [${a.player}] + dealer ${a.dealer}`);
  console.log(`  (Exact finite-deck · 51-card published rules · hole card hidden)`);
  console.log('');
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node bj-helper.js "<player cards>" <dealer upcard>');
    console.log('Example: node bj-helper.js "10 6" 9');
    console.log('Example: node bj-helper.js "A 7" 6');
    process.exit(1);
  }

  try {
    const player = parseHand(args[0]);
    const dealer = parseRank(args[1]);
    const advice = advise(player, dealer);
    printAdvice(advice);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

module.exports = { advise, parseHand, parseRank, formatEV };
