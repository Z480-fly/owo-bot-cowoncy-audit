'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  advise,
  formatAdviceMessage,
  formatEndedMessage,
} = require('../blackjack-advisor');
const {
  createVisibleEvaluator,
  BASE_51,
} = require('../finite-deck-solver');
const { parseOwOBlackjackMessage } = require('../owo-blackjack-parser');
const { DEFAULT_OWO_BOT_ID, makeOwOMessage, endedMessage } = require('./fixtures');

function stateFor(message) {
  const parsed = parseOwOBlackjackMessage(message, { owoBotId: DEFAULT_OWO_BOT_ID });
  assert.equal(parsed.ok, true, parsed.reason);
  return parsed.state;
}

test('matches the known exact 10,6 vs 9 decision and EV values', () => {
  const state = stateFor(makeOwOMessage());
  const advice = advise(state);

  assert.equal(advice.action, 'HIT');
  assert.equal(advice.total, 16);
  assert.equal(advice.soft, false);
  assert.ok(Math.abs(advice.standEV - -0.5499498096802489) < 1e-12);
  assert.ok(Math.abs(advice.hitEV - -0.3345027672118799) < 1e-12);
});

test('formats HIT, both EV values, the hand, and the hidden-hole note', () => {
  const state = stateFor(makeOwOMessage());
  const content = formatAdviceMessage(state, advise(state));

  assert.match(content, /^# HIT/m);
  assert.match(content, /Hard 16/);
  assert.match(content, /dealer \*\*9\*\*/);
  assert.match(content, /Stand EV: -0\.5499/);
  assert.match(content, /Hit EV: -0\.3345/);
  assert.match(content, /dealer hole hidden/);
  assert.match(content, /Open the OwO hand/);
});

test('keeps a four-ace hand soft and does not use a hidden card', () => {
  const state = stateFor(
    makeOwOMessage({
      player: ['as', 'ah', 'ac', 'ad'],
      dealer: ['9c'],
    })
  );
  const advice = advise(state);

  assert.equal(advice.soft, true);
  assert.equal(advice.total, 14);
  assert.equal(state.dealerHiddenCount, 1);
  assert.equal(state.dealerUpRank, 8);
});

test('stands on three sevens', () => {
  const state = stateFor(
    makeOwOMessage({
      player: ['7s', '7c', '7d'],
      dealer: ['2c'],
    })
  );
  const advice = advise(state);

  assert.equal(advice.total, 21);
  assert.equal(advice.action, 'STAND');
});

test('returns BUST with no hit/stand values and formats no impossible decision', () => {
  const state = stateFor(
    makeOwOMessage({
      player: ['10s', '6h', '9d'],
      dealer: ['9c'],
    })
  );
  const advice = advise(state);
  const content = formatAdviceMessage(state, advice);

  assert.equal(advice.action, 'BUST');
  assert.equal(advice.bust, true);
  assert.equal(advice.standEV, null);
  assert.equal(advice.hitEV, null);
  assert.match(content, /^# BUST/m);
  assert.match(content, /Bust settlement EV:/);
  assert.doesNotMatch(content, /Stand EV:/);
});

test('rejects too many cards of one rank', () => {
  const state = {
    phase: 'in_progress',
    playerRanks: Array(17).fill(9),
    dealerUpRank: 8,
  };
  assert.throws(() => advise(state), /too many cards/);
});

test('rejects a completed hand', () => {
  assert.throws(() => advise(stateFor(endedMessage())), /in-progress/);
});

test('matches an independent wrapper call across deterministic reachable states', () => {
  const reference = createVisibleEvaluator('51-push');
  let seed = 0x8badf00d;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let i = 0; i < 200; i++) {
    const counts = BASE_51.slice();
    const playerRanks = [];
    const cardCount = 2 + Math.floor(next() * 4);
    for (let j = 0; j < cardCount; j++) {
      let rank;
      do {
        rank = Math.floor(next() * 10);
      } while (counts[rank] <= 0);
      counts[rank]--;
      playerRanks.push(rank);
    }
    let upRank;
    do {
      upRank = Math.floor(next() * 10);
    } while (counts[upRank] <= 0);

    const state = {
      phase: 'in_progress',
      playerRanks,
      dealerUpRank: upRank,
    };
    const advice = advise(state);
    const expected = reference(playerRanks, upRank);

    assert.equal(advice.total, expected.total);
    assert.equal(advice.soft, expected.soft);
    assert.equal(advice.bust, expected.bust);
    assert.equal(advice.action, expected.bust ? 'BUST' : expected.action.toUpperCase());
    assert.deepEqual(
      [advice.standEV, advice.hitEV, advice.ev, advice.ev2],
      [expected.standEV, expected.hitEV, expected.ev, expected.ev2]
    );
  }
});

test('formats completed hands without a recommendation', () => {
  const content = formatEndedMessage(stateFor(endedMessage()));
  assert.match(content, /^# HAND COMPLETE/m);
  assert.match(content, /You won/);
  assert.doesNotMatch(content, /# HIT|# STAND/);
});
