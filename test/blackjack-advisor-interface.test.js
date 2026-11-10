'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  AdvisorInputError,
  VERIFIED_RULES,
  analyzeHand,
  formatAnalysis,
} = require('../blackjack-advisor');
const {
  BlackjackSessionManager,
  BlackjackStats,
  BlackjackTableTracker,
} = require('../blackjack-session');
const { DEFAULT_OWO_BOT_ID, makeOwOMessage, endedMessage } = require('./fixtures');

const ADVISOR_PATH = path.join(__dirname, '..', 'blackjack-advisor.js');

function analyze(dealer, playerCards, overrides = {}) {
  return analyzeHand({
    dealer,
    playerCards,
    rules: VERIFIED_RULES,
    ...overrides,
  });
}

class FakeSink {
  constructor() {
    this.calls = [];
    this.reports = [];
    this.nextId = 1;
  }

  async upsert(channelId, messageId, content) {
    const id = messageId || `advice-${this.nextId++}`;
    this.calls.push({ channelId, messageId, id, content });
    return id;
  }

  async report(channelId, content) {
    this.reports.push({ channelId, content });
  }
}

test('analyzes hard 16 against dealer 8', () => {
  const result = analyze('8', ['10', '6']);

  assert.equal(result.playerTotal, 16);
  assert.equal(result.handType, 'hard');
  assert.equal(result.recommendation, 'HIT');
  assert.equal(result.confidence, 'high');
  assert.ok(Math.abs(result.expectedValues.hit - -0.2722233044211234) < 1e-12);
  assert.ok(Math.abs(result.expectedValues.stand - -0.5363753255869728) < 1e-12);
  assert.equal(result.remainingCards, 48);
  assert.equal(result.dealerOutcomes.bust, 0.23181233720651356);
});

test('analyzes hard 15 against dealer 10', () => {
  const result = analyze('10', ['10', '5']);

  assert.equal(result.playerTotal, 15);
  assert.equal(result.handType, 'hard');
  assert.equal(result.recommendation, 'HIT');
  assert.ok(Math.abs(result.expectedValues.hit - -0.40189331014822294) < 1e-12);
  assert.ok(Math.abs(result.expectedValues.stand - -0.5646426418810948) < 1e-12);
});

test('analyzes soft 17 against dealer 8 without treating it as hard 17', () => {
  const result = analyze('8', ['A', '6']);

  assert.equal(result.playerTotal, 17);
  assert.equal(result.handType, 'soft');
  assert.equal(result.recommendation, 'HIT');
  assert.ok(Math.abs(result.expectedValues.hit - 0.011023289924209242) < 1e-12);
  assert.ok(Math.abs(result.expectedValues.stand - -0.394133349935471) < 1e-12);
});

test('values aces correctly in soft and hard multi-card hands', () => {
  const twoAces = analyze('8', ['A', 'A']);
  assert.equal(twoAces.playerTotal, 12);
  assert.equal(twoAces.handType, 'soft');

  const aceDrops = analyze('8', ['A', '6', '10']);
  assert.equal(aceDrops.playerTotal, 17);
  assert.equal(aceDrops.handType, 'hard');

  const fourAces = analyze('8', ['A', 'A', 'A', 'A']);
  assert.equal(fourAces.playerTotal, 14);
  assert.equal(fourAces.handType, 'soft');
});

test('accepts a multiple-card hand and returns a real recommendation', () => {
  const result = analyze('10', ['10', '3', '2']);

  assert.equal(result.playerTotal, 15);
  assert.ok(['HIT', 'STAND'].includes(result.recommendation));
  assert.ok(Number.isFinite(result.expectedValues.hit));
  assert.ok(Number.isFinite(result.expectedValues.stand));
});

test('removes explicitly observed cards and reports the reduced composition', () => {
  const base = analyze('8', ['10', '6']);
  const observed = analyze('8', ['10', '6'], { observedCards: ['2', '3'] });

  assert.equal(observed.observedCards.length, 2);
  assert.equal(observed.remainingCards, 46);
  assert.equal(observed.remainingComposition['2'], 3);
  assert.equal(observed.remainingComposition['3'], 3);
  assert.notEqual(observed.expectedValues.hit, base.expectedValues.hit);
  assert.ok(
    Math.abs(
      Object.values(observed.dealerOutcomes).reduce((sum, value) => sum + value, 0) - 1
    ) < 1e-12
  );
});

test('rejects duplicate physical cards and duplicate registration', () => {
  assert.throws(
    () => analyze('8', ['10s', '10s']),
    (error) => error instanceof AdvisorInputError && error.code === 'DUPLICATE_CARD'
  );
  assert.throws(
    () => analyze('8s', ['8s', '6h']),
    (error) => error instanceof AdvisorInputError && error.code === 'DUPLICATE_CARD'
  );
  assert.throws(
    () => analyze('8', ['10s', '6h'], { observedCards: ['10s'] }),
    (error) => error instanceof AdvisorInputError && error.code === 'DUPLICATE_CARD'
  );
});

test('rejects missing card information and impossible compositions', () => {
  assert.throws(() => analyze('8', ['10']), /At least two visible player cards/);
  assert.throws(() => analyze(undefined, ['10', '6']), /dealer must be a card/);
  assert.throws(
    () => analyze('8', Array(17).fill('10')),
    (error) => error instanceof AdvisorInputError && error.code === 'INVALID_COMPOSITION'
  );
  assert.throws(() => analyze('8', ['7h', '7s']), /omits 7♥/);
});

test('returns pending with no fabricated EV when rules are incomplete or unsupported', () => {
  const pending = analyzeHand({
    dealer: '8',
    playerCards: ['10', '6'],
    rules: { dealerHitsSoft17: null, deckCount: null },
  });

  assert.equal(pending.confidence, 'pending');
  assert.equal(pending.recommendation, null);
  assert.equal(pending.expectedValues.hit, null);
  assert.equal(pending.expectedValues.stand, null);
  assert.equal(pending.dealerOutcomes, null);
  assert.match(pending.reason, /No solver values/);

  const coreRulesOnly = analyzeHand({
    dealer: '8',
    playerCards: ['10', '6'],
    rules: { dealerHitsSoft17: false, deckCount: 1 },
  });
  assert.equal(coreRulesOnly.confidence, 'high');
  assert.equal(coreRulesOnly.rules.deckSize, 51);
  assert.equal(coreRulesOnly.rules.source, VERIFIED_RULES.source);
  assert.deepEqual(coreRulesOnly.rules.defaulted, [
    'deckSize',
    'bothBust',
    'blackjackPays',
    'doubleAllowed',
    'splitAllowed',
  ]);

  const explicitlyUnknown = analyzeHand({
    dealer: '8',
    playerCards: ['10', '6'],
    rules: { dealerHitsSoft17: false, deckCount: 1, deckSize: null },
  });
  assert.equal(explicitlyUnknown.confidence, 'pending');
  assert.deepEqual(explicitlyUnknown.rules.missing, ['deckSize']);

  const unsupported = analyzeHand({
    dealer: '8',
    playerCards: ['10', '6'],
    rules: { ...VERIFIED_RULES, dealerHitsSoft17: true },
  });
  assert.equal(unsupported.confidence, 'unsupported');
  assert.equal(unsupported.recommendation, null);
  assert.match(unsupported.reason, /soft 17/);
});

test('rejects invalid cards and arguments', () => {
  assert.throws(() => analyze('8', ['11', '6']), /not a recognized card/);
  const wrongDeck = analyze('8', ['10', '6'], {
    rules: { ...VERIFIED_RULES, deckSize: 52 },
  });
  assert.equal(wrongDeck.confidence, 'unsupported');
  assert.match(wrongDeck.reason, /single 51-card/);

  const wrongSplit = analyze('8', ['10', '6'], {
    rules: { ...VERIFIED_RULES, splitAllowed: true },
  });
  assert.equal(wrongSplit.confidence, 'unsupported');
  assert.match(wrongSplit.reason, /split/);
});

test('formats a clear text response and JSON has the same values', () => {
  const result = analyze('8', ['10', '6']);
  const text = formatAnalysis(result);

  assert.match(text, /Dealer: 8/);
  assert.match(text, /Player: 10 \+ 6/);
  assert.match(text, /Total: 16/);
  assert.match(text, /Hand: HARD/);
  assert.match(text, /Recommendation: HIT/);
  assert.match(text, /STAND EV: -0\.5364/);
  assert.match(text, /HIT EV: -0\.2722/);
  assert.match(text, /Bust probability if hit/);
  assert.match(text, /Dealer final outcomes/);
  assert.match(text, /Remaining composition/);

  const cli = spawnSync(
    process.execPath,
    [ADVISOR_PATH, '--dealer', '8', '--cards', '10,6', '--json'],
    { encoding: 'utf8' }
  );
  assert.equal(cli.status, 0, cli.stderr);
  const json = JSON.parse(cli.stdout);
  assert.equal(json.recommendation, 'HIT');
  assert.equal(json.playerTotal, 16);
  assert.ok(Math.abs(json.expectedValues.hit - result.expectedValues.hit) < 1e-12);
  assert.equal(json.rules.status, 'verified');
});

test('CLI returns a non-zero status for pending rules and invalid input', () => {
  const pending = spawnSync(
    process.execPath,
    [ADVISOR_PATH, '--dealer', '8', '--cards', '10,6', '--rules', 'unknown'],
    { encoding: 'utf8' }
  );
  assert.equal(pending.status, 1);
  assert.match(pending.stdout, /Recommendation: PENDING/);

  const invalid = spawnSync(
    process.execPath,
    [ADVISOR_PATH, '--dealer', '8', '--cards', '10'],
    { encoding: 'utf8' }
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /At least two visible player cards/);
});

test('manual tracker prevents duplicates and supports corrected card recognition', () => {
  const tracker = new BlackjackTableTracker({ rules: VERIFIED_RULES });
  const initial = tracker.beginHand({
    dealer: '8s',
    playerCards: ['10s', '6h'],
  });
  assert.equal(initial.playerTotal, 16);

  assert.throws(() => tracker.addPlayerCard('10s'), /Duplicate card registration/);

  const corrected = tracker.correctCard({ zone: 'player', index: 1, card: '5h' });
  assert.equal(corrected.playerTotal, 15);
  assert.deepEqual(corrected.playerCards, ['10', '5']);
  assert.equal(tracker.getHistory().length, 0);

  tracker.recordResult({ outcome: 'win', recommendationCorrect: true });
  assert.equal(tracker.getHistory().length, 1);
  assert.equal(tracker.getHistory()[0].outcome, 'win');
});

test('tracker resets observed cards between hands and keeps prior history', () => {
  const tracker = new BlackjackTableTracker({ rules: VERIFIED_RULES });
  const first = tracker.beginHand({
    dealer: '8',
    playerCards: ['10', '6'],
    observedCards: ['2', '3'],
  });
  assert.equal(first.remainingCards, 46);

  tracker.recordResult({ outcome: 'loss' });
  const second = tracker.beginHand({ dealer: '8', playerCards: ['10', '6'] });
  assert.equal(second.remainingCards, 48);
  assert.deepEqual(second.observedCards, []);
  assert.equal(tracker.getHistory().length, 1);
});

test('statistics keep win rate separate from recommendation accuracy', () => {
  const stats = new BlackjackStats();
  stats.record({
    outcome: 'win',
    recommendation: 'HIT',
    dealer: '8',
    handType: 'hard',
    recommendationCorrect: true,
  });
  stats.record({
    outcome: 'loss',
    recommendation: 'STAND',
    dealer: '10',
    handType: 'soft',
    recommendationCorrect: false,
  });
  stats.record({
    outcome: 'push',
    recommendation: 'HIT',
    dealer: '8',
    handType: 'hard',
    recommendationCorrect: null,
  });

  const summary = stats.summary();
  assert.equal(summary.hands, 3);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.pushes, 1);
  assert.equal(summary.winRate, 1 / 3);
  assert.equal(summary.hitRecommendations, 2);
  assert.equal(summary.standRecommendations, 1);
  assert.equal(summary.recommendationAccuracy, 0.5);
  assert.equal(summary.recommendationAccuracySamples, 2);
  assert.equal(summary.byDealerUpcard['8'].hands, 2);
  assert.equal(summary.byHandType.hard.hands, 2);
});

test('Discord session manager records completed-hand statistics', async () => {
  const sink = new FakeSink();
  const manager = new BlackjackSessionManager({
    sink,
    trackedChannelIds: ['channel-1'],
    owoBotId: DEFAULT_OWO_BOT_ID,
    idleMs: 10_000,
    now: () => 1_000,
  });

  await manager.handleMessage(makeOwOMessage());
  await manager.handleMessage(endedMessage({ editedTimestamp: 2_000 }));

  const summary = manager.getStats();
  assert.equal(summary.hands, 1);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 0);
  assert.equal(summary.pushes, 0);
  assert.equal(summary.recommendationAccuracy, null);
  assert.equal(summary.hitRecommendations, 1);
  assert.equal(manager.getHistory()[0].recommendation, 'HIT');
  assert.match(manager.getHistory()[0].footerStatus, /You won/);
});
