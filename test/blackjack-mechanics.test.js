'use strict';

/*
 * Independent mechanics checks for the published OwO blackjack source.
 *
 * The deck identities are rebuilt here from the source's 1..52 array minus the
 * missing 7h (card 33). These tests deliberately do not import a deck builder
 * from the application; they verify the solver against that independent list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BASE_51,
  BASE_52,
  addRank,
  remainingCounts,
  dealerOutcomeDistribution,
  evaluateVisibleState,
} = require('../finite-deck-solver');
const {
  advise,
} = require('../blackjack-advisor');
const { BlackjackSessionManager } = require('../blackjack-session');
const { parseOwOBlackjackMessage } = require('../owo-blackjack-parser');
const {
  DEFAULT_OWO_BOT_ID,
  makeOwOMessage,
  endedMessage,
} = require('./fixtures');

const SOURCE_DECK = Array.from({ length: 52 }, (_unused, index) => index + 1)
  .filter((card) => card !== 33);

function sourceRank(card) {
  const value = card % 13;
  if (value === 0 || value >= 10) return 9;
  if (value > 1) return value - 1;
  return 0;
}

function sourceValue(rank) {
  return rank === 0 ? 11 : rank === 9 ? 10 : rank + 1;
}

function independentAddCard(total, soft, rank) {
  if (rank === 0) {
    if (total + 11 <= 21) return { total: total + 11, soft: true };
    let next = total + 1;
    if (next > 21 && soft) {
      next -= 10;
      soft = false;
    }
    return { total: next, soft: soft && next <= 21 };
  }
  const value = sourceValue(rank);
  let next = total + value;
  if (next > 21 && soft) {
    next -= 10;
    soft = false;
  }
  return { total: next, soft: soft && next <= 21 };
}

/*
 * Independent dealer distribution. It removes one arbitrary identity for each
 * visible rank, keeps every unseen card as a possible hole, and recursively
 * draws without replacement. It is intentionally separate from the solver's
 * rank-count dynamic program.
 */
function independentDealerDistribution(playerRanks, upRank, observedRanks = []) {
  const deck = SOURCE_DECK.slice();
  const take = (rank) => {
    const index = deck.findIndex((card) => sourceRank(card) === rank);
    if (index < 0) throw new Error(`no identity for rank ${rank}`);
    return deck.splice(index, 1)[0];
  };

  for (const rank of playerRanks) take(rank);
  const upCard = take(upRank);
  for (const rank of observedRanks) take(rank);
  const holes = deck.slice();
  const out = new Array(6).fill(0);

  function recurse(total, soft, remaining, probability) {
    if (total >= 17) {
      out[total > 21 ? 5 : total - 17] += probability;
      return;
    }
    if (!remaining.length) throw new Error('dealer exhausted below 17');
    for (let i = 0; i < remaining.length; i++) {
      const nextDeck = remaining.slice(0, i).concat(remaining.slice(i + 1));
      const next = independentAddCard(total, soft, sourceRank(remaining[i]));
      recurse(next.total, next.soft, nextDeck, probability / remaining.length);
    }
  }

  for (let i = 0; i < holes.length; i++) {
    const hole = holes[i];
    const nextDeck = holes.slice(0, i).concat(holes.slice(i + 1));
    const afterUp = independentAddCard(0, false, sourceRank(upCard));
    const afterHole = independentAddCard(afterUp.total, afterUp.soft, sourceRank(hole));
    recurse(afterHole.total, afterHole.soft, nextDeck, 1 / holes.length);
  }

  return out;
}

function parseState(message) {
  const parsed = parseOwOBlackjackMessage(message, { owoBotId: DEFAULT_OWO_BOT_ID });
  assert.equal(parsed.ok, true, parsed.reason);
  return parsed.state;
}

class FakeSink {
  constructor() {
    this.calls = [];
    this.nextId = 1;
  }

  async upsert(channelId, messageId, content) {
    const id = messageId || `advice-${this.nextId++}`;
    this.calls.push({ channelId, messageId, id, content });
    return id;
  }

  async report() {}
}

test('the published deck is 51 unique cards and has exactly three sevens', () => {
  assert.equal(SOURCE_DECK.length, 51);
  assert.equal(new Set(SOURCE_DECK).size, 51);
  assert.equal(SOURCE_DECK.includes(33), false, 'card 33 is the missing 7h');
  assert.equal(SOURCE_DECK.filter((card) => card % 13 === 7).length, 3);
  assert.equal(SOURCE_DECK.filter((card) => card % 13 === 0).length, 4);
  assert.equal(SOURCE_DECK.filter((card) => card % 13 >= 10).length, 12);

  const counts = new Array(10).fill(0);
  for (const card of SOURCE_DECK) counts[sourceRank(card)]++;
  assert.deepEqual(counts, BASE_51);
  assert.deepEqual(counts, [4, 4, 4, 4, 4, 4, 3, 4, 4, 16]);
  assert.deepEqual(BASE_52, [4, 4, 4, 4, 4, 4, 4, 4, 4, 16]);
});

test('the source deck is restored after cards are removed from a game copy', () => {
  const base = SOURCE_DECK.slice();
  const gameOne = base.slice();
  const drawn = [];
  for (let i = 0; i < 7; i++) drawn.push(gameOne.splice(0, 1)[0]);

  assert.equal(gameOne.length, 44);
  assert.equal(base.length, 51);
  assert.equal(new Set(drawn).size, drawn.length);

  const gameTwo = base.slice();
  assert.equal(gameTwo.length, 51);
  assert.deepEqual(gameTwo, SOURCE_DECK);
  assert.equal(gameTwo.filter((card) => card === 33).length, 0);
});

test('visible cards deplete the remaining composition within one hand', () => {
  const before = remainingCounts('51-push', [9, 5], 8);
  const after = remainingCounts('51-push', [9, 5, 4], 8);

  assert.equal(before.n, 48);
  assert.equal(after.n, 47);
  assert.equal(before.counts[4] - after.counts[4], 1);
  assert.equal(before.counts[6], after.counts[6]);
  assert.equal(after.counts[6], 3);
});

test('three sevens can be removed but a fourth seven is impossible', () => {
  const three = remainingCounts('51-push', [6, 6, 6], 8);
  assert.equal(three.counts[6], 0);
  assert.throws(
    () => remainingCounts('51-push', [6, 6, 6, 6], 8),
    /too many cards/
  );
});

test('dealer distribution includes the unknown hole card and sums to one', () => {
  const state = [9, 6];
  const upRank = 8;
  const actual = dealerOutcomeDistribution('51-push', state, upRank);
  const independent = independentDealerDistribution(state, upRank);

  assert.equal(actual.length, 6);
  assert.ok(Math.abs(actual.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(Math.abs(actual[i] - independent[i]) < 1e-12, `outcome ${i}`);
  }
  assert.ok(actual[5] > 0, 'the dealer can bust');
});

test('observed cards remove independent identities from the dealer distribution', () => {
  const playerRanks = [9, 5];
  const upRank = 8;
  const observedRanks = [2, 3];
  const actual = dealerOutcomeDistribution('51-push', playerRanks, upRank, observedRanks);
  const independent = independentDealerDistribution(playerRanks, upRank, observedRanks);
  const remaining = remainingCounts('51-push', playerRanks, upRank, observedRanks);

  assert.equal(remaining.n, 46);
  assert.equal(remaining.counts[2], 3);
  assert.equal(remaining.counts[3], 3);
  assert.equal(actual.length, 6);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(Math.abs(actual[i] - independent[i]) < 1e-12, `observed outcome ${i}`);
  }
});

test('soft and hard seventeen are distinct states', () => {
  const soft = advise({ phase: 'in_progress', playerRanks: [0, 5], dealerUpRank: 8 });
  const hard = advise({ phase: 'in_progress', playerRanks: [9, 6], dealerUpRank: 8 });

  assert.equal(soft.total, 17);
  assert.equal(soft.soft, true);
  assert.equal(hard.total, 17);
  assert.equal(hard.soft, false);
  assert.notEqual(soft.standEV, hard.standEV);
});

test('both-bust push is exactly the dealer-bust probability better than loss', () => {
  const playerRanks = [9, 9, 2]; // 10 + 10 + 3 = 23
  const upRank = 7;
  const distribution = dealerOutcomeDistribution('51-push', playerRanks, upRank);
  const push = evaluateVisibleState('51-push', playerRanks, upRank);
  const loss = evaluateVisibleState('51-loss', playerRanks, upRank);

  assert.equal(distribution.length, 6);
  assert.ok(push.ev > loss.ev);
  assert.ok(Math.abs(push.ev - (loss.ev + distribution[5])) < 1e-12);
  assert.ok(Math.abs(loss.ev - -1) < 1e-12);
});

test('the 51-card and 52-card models differ when a seven is removed', () => {
  const published = remainingCounts('51-push', [6, 6], 8);
  const corrected = remainingCounts('52-push', [6, 6], 8);
  const publishedEv = evaluateVisibleState('51-push', [6, 6], 8).ev;
  const correctedEv = evaluateVisibleState('52-push', [6, 6], 8).ev;

  assert.equal(published.counts[6], 1);
  assert.equal(corrected.counts[6], 2);
  assert.notEqual(publishedEv, correctedEv);
});

test('a fresh game does not inherit card depletion from the previous game', async () => {
  const sink = new FakeSink();
  const manager = new BlackjackSessionManager({
    sink,
    trackedChannelIds: ['channel-1'],
    owoBotId: DEFAULT_OWO_BOT_ID,
    idleMs: 10_000,
    now: () => 1_000,
  });

  const firstMessage = makeOwOMessage({
    player: ['7s', '7c', '7d'],
    dealer: ['2c'],
  });
  const firstAdvice = advise(parseState(firstMessage));
  await manager.handleMessage(firstMessage);
  assert.equal(sink.calls.length, 1);

  await manager.handleMessage(endedMessage({ editedTimestamp: 2_000 }));
  const secondMessage = makeOwOMessage({
    id: 'message-2',
    player: ['7s', '7c', '7d'],
    dealer: ['2c'],
    createdTimestamp: 3_000,
  });
  const secondAdvice = advise(parseState(secondMessage));
  const secondResult = await manager.handleMessage(secondMessage);

  assert.equal(secondResult.status, 'started');
  assert.deepEqual(secondAdvice, firstAdvice);
  assert.equal(sink.calls.length, 3);
  assert.equal(sink.calls.at(-1).messageId, null);
});
