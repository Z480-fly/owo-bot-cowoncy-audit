'use strict';

const {
  addRank,
  createVisibleEvaluator,
  dealerOutcomeDistribution,
  remainingCounts,
} = require('./finite-deck-solver');

const RANK_LABELS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const CARD_RE = /^(a|2|3|4|5|6|7|8|9|10|t|j|q|k)([scdh])?$/i;

/*
 * These are the rules verified in BLACKJACK-MECHANICS-RESEARCH.md. They are
 * deliberately explicit in every calculated result; an API caller cannot get
 * EV numbers by leaving a rule unknown.
 */
const VERIFIED_RULES = Object.freeze({
  dealerHitsSoft17: false,
  deckCount: 1,
  deckSize: 51,
  bothBust: 'push',
  blackjackPays: '1:1',
  doubleAllowed: false,
  splitAllowed: false,
  source: 'published OwO source 9aec92b274bae64ea078fc04540398713e7f7928',
});

const CORE_RULE_FIELDS = ['dealerHitsSoft17', 'deckCount'];
const OPTIONAL_RULE_FIELDS = [
  'deckSize',
  'bothBust',
  'blackjackPays',
  'doubleAllowed',
  'splitAllowed',
];
const RULE_FIELDS = [...CORE_RULE_FIELDS, ...OPTIONAL_RULE_FIELDS];

// One evaluator keeps the solver's exact dynamic-programming memoization.
const evaluateVisible = createVisibleEvaluator('51-push');

class AdvisorInputError extends Error {
  constructor(message, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'AdvisorInputError';
    this.code = code;
  }
}

function formatEV(value) {
  if (!Number.isFinite(value)) return '—';
  return value >= 0 ? `+${value.toFixed(4)}` : value.toFixed(4);
}

function parseCard(value, label = 'card') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AdvisorInputError(`${label} must be a card such as 8, 10, A, or 7s`);
  }

  const raw = value.trim();
  const match = CARD_RE.exec(raw);
  if (!match) {
    throw new AdvisorInputError(
      `${label} ${raw} is not a recognized card; use A, 2-9, 10, T, J, Q, K, optionally followed by s/c/d/h`
    );
  }

  const face = match[1].toUpperCase();
  const suit = match[2] ? match[2].toLowerCase() : null;
  if (face === '7' && suit === 'h') {
    throw new AdvisorInputError(
      'The published OwO 51-card deck omits 7♥; this card cannot be registered',
      'RULES_MISMATCH'
    );
  }

  let rank;
  let cardLabel;
  if (face === 'A') {
    rank = 0;
    cardLabel = 'A';
  } else if (face === 'T' || face === 'J' || face === 'Q' || face === 'K') {
    rank = 9;
    cardLabel = face === 'T' ? '10' : face;
  } else {
    rank = Number(face) - 1;
    cardLabel = String(Number(face));
  }

  return {
    rank,
    label: cardLabel,
    face,
    suit,
    identity: suit ? `${face === 'T' ? '10' : face.toLowerCase()}${suit}` : null,
  };
}

function parseCardList(value, label = 'cards') {
  if (value === undefined || value === null) return [];
  const parts = Array.isArray(value)
    ? value
    : String(value).split(/[\s,]+/).filter(Boolean);
  return parts.map((item, index) => parseCard(item, `${label}[${index}]`));
}

function assertNoExactDuplicates(cards) {
  const seen = new Set();
  for (const card of cards) {
    if (!card.identity) continue;
    if (seen.has(card.identity)) {
      throw new AdvisorInputError(
        `Duplicate card registration: ${card.label}${card.suit} was supplied more than once`,
        'DUPLICATE_CARD'
      );
    }
    seen.add(card.identity);
  }
}

function cardLabelList(cards) {
  return cards.map((card) => card.label);
}

function handFromRanks(ranks) {
  let hand = { total: 0, soft: false };
  for (const rank of ranks) hand = addRank(hand.total, hand.soft, rank);
  return hand;
}

function pendingRuleState(reason, missing = []) {
  return {
    status: 'pending',
    reason,
    missing,
  };
}

function normalizeRules(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    return pendingRuleState(
      'Verified game rules were not supplied. No solver values were calculated.',
      RULE_FIELDS
    );
  }

  const missing = CORE_RULE_FIELDS.filter(
    (field) => rules[field] === undefined || rules[field] === null
  );
  const explicitlyUnknown = OPTIONAL_RULE_FIELDS.filter(
    (field) => Object.prototype.hasOwnProperty.call(rules, field) && rules[field] === null
  );
  const unknown = [...missing, ...explicitlyUnknown];
  if (unknown.length > 0) {
    return pendingRuleState(
      `Awaiting verified game rules: ${unknown.join(', ')}. No solver values were calculated.`,
      unknown
    );
  }

  const effectiveRules = { ...VERIFIED_RULES, ...rules };
  const defaulted = OPTIONAL_RULE_FIELDS.filter(
    (field) => rules[field] === undefined
  );

  if (typeof effectiveRules.dealerHitsSoft17 !== 'boolean') {
    return pendingRuleState('dealerHitsSoft17 must be a boolean.', ['dealerHitsSoft17']);
  }
  if (!Number.isInteger(effectiveRules.deckCount) || effectiveRules.deckCount < 1) {
    return pendingRuleState('deckCount must be a positive integer.', ['deckCount']);
  }
  if (!Number.isInteger(effectiveRules.deckSize) || effectiveRules.deckSize < 1) {
    return pendingRuleState('deckSize must be a positive integer.', ['deckSize']);
  }

  if (effectiveRules.dealerHitsSoft17 !== false) {
    return {
      status: 'unsupported',
      reason: 'This solver only implements a dealer who stands on soft 17.',
    };
  }
  if (effectiveRules.deckCount !== 1 || effectiveRules.deckSize !== 51) {
    return {
      status: 'unsupported',
      reason: 'This solver only implements the published single 51-card OwO deck.',
    };
  }
  if (effectiveRules.bothBust !== 'push') {
    return {
      status: 'unsupported',
      reason: 'This solver only implements the published both-bust push rule.',
    };
  }
  if (effectiveRules.blackjackPays !== '1:1') {
    return {
      status: 'unsupported',
      reason: 'This solver only implements the published 1:1 natural payout.',
    };
  }
  if (effectiveRules.doubleAllowed !== false) {
    return {
      status: 'unsupported',
      reason: 'This solver does not implement double-down.',
    };
  }
  if (effectiveRules.splitAllowed !== false) {
    return {
      status: 'unsupported',
      reason: 'This solver does not implement split hands.',
    };
  }

  return {
    status: 'verified',
    rules: {
      status: 'verified',
      ...effectiveRules,
      source: effectiveRules.source || VERIFIED_RULES.source,
      defaulted,
    },
  };
}

function bustProbabilityFromCounts(total, soft, counts) {
  let unseen = 0;
  let bustCards = 0;
  for (let rank = 0; rank < counts.length; rank++) {
    const count = counts[rank];
    if (!count) continue;
    unseen += count;
    if (addRank(total, soft, rank).total > 21) bustCards += count;
  }
  return unseen > 0 ? bustCards / unseen : null;
}

function dealerOutcomeObject(distribution) {
  return {
    17: distribution[0],
    18: distribution[1],
    19: distribution[2],
    20: distribution[3],
    21: distribution[4],
    bust: distribution[5],
  };
}

function compositionObject(counts) {
  const out = {};
  for (let rank = 0; rank < RANK_LABELS.length; rank++) {
    out[RANK_LABELS[rank]] = counts[rank];
  }
  return out;
}

function recommendationReason(analysis) {
  if (analysis.recommendation === 'BUST') {
    return 'The player total exceeds 21; no HIT or STAND decision remains.';
  }
  const hit = analysis.expectedValues.hit;
  const stand = analysis.expectedValues.stand;
  if (analysis.recommendation === 'HIT') {
    return `HIT has the higher exact EV by ${(hit - stand).toFixed(4)}.`;
  }
  if (Math.abs(hit - stand) < 1e-12) {
    return 'HIT and STAND have equal exact EV; the solver returns STAND as the tie-break.';
  }
  return `STAND has the higher exact EV by ${(stand - hit).toFixed(4)}.`;
}

/*
 * Analyze one visible hand. Unknown or unsupported rules return a descriptive
 * result with null values; the solver is never called with guessed rules.
 */
function analyzeHand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AdvisorInputError('A hand object with dealer, playerCards, and rules is required');
  }

  const dealer = parseCard(input.dealer, 'dealer');
  const playerCards = parseCardList(input.playerCards, 'playerCards');
  const observedCards = parseCardList(input.observedCards, 'observedCards');

  if (playerCards.length < 2) {
    throw new AdvisorInputError('At least two visible player cards are required', 'MISSING_CARDS');
  }

  assertNoExactDuplicates([dealer, ...playerCards, ...observedCards]);

  const playerRanks = playerCards.map((card) => card.rank);
  const observedRanks = observedCards.map((card) => card.rank);
  const hand = handFromRanks(playerRanks);
  const base = {
    dealer: RANK_LABELS[dealer.rank],
    dealerSuit: dealer.suit,
    playerCards: cardLabelList(playerCards),
    observedCards: cardLabelList(observedCards),
    playerTotal: hand.total,
    handType: hand.soft ? 'soft' : 'hard',
    recommendation: null,
    expectedValues: {
      hit: null,
      stand: null,
    },
    confidence: 'pending',
    reason: null,
    rules: null,
    solver: null,
    bustProbability: null,
    dealerOutcomes: null,
    remainingCards: null,
    remainingComposition: null,
    ev: null,
    ev2: null,
  };

  const ruleState = normalizeRules(input.rules);
  if (ruleState.status !== 'verified') {
    return {
      ...base,
      confidence: ruleState.status,
      recommendation: null,
      reason: ruleState.reason,
      rules: ruleState,
    };
  }

  // Let the solver validate physical-count limits after rules are known.
  let result;
  let remaining;
  let distribution;
  try {
    result = evaluateVisible(playerRanks, dealer.rank, observedRanks);
    remaining = remainingCounts('51-push', playerRanks, dealer.rank, observedRanks);
    distribution = dealerOutcomeDistribution('51-push', playerRanks, dealer.rank, observedRanks);
  } catch (error) {
    throw new AdvisorInputError(error.message, 'INVALID_COMPOSITION');
  }

  const recommendation = result.bust
    ? 'BUST'
    : result.action === 'hit'
      ? 'HIT'
      : 'STAND';

  const analysis = {
    ...base,
    recommendation,
    expectedValues: {
      hit: result.hitEV,
      stand: result.standEV,
    },
    confidence: 'high',
    rules: ruleState.rules,
    solver: {
      variant: '51-push',
      method: 'exact finite-deck dynamic programming',
      dealerHole: 'unknown; included in remaining composition',
    },
    bustProbability: result.bust ? null : bustProbabilityFromCounts(hand.total, hand.soft, remaining.counts),
    dealerOutcomes: dealerOutcomeObject(distribution),
    remainingCards: remaining.n,
    remainingComposition: compositionObject(remaining.counts),
    ev: result.ev,
    ev2: result.ev2,
  };
  analysis.reason = recommendationReason(analysis);
  return analysis;
}

/* Backwards-compatible Discord entry point over parsed OwO state. */
function advise(state) {
  if (!state || state.phase !== 'in_progress') {
    throw new Error('Advisor only evaluates an in-progress visible hand');
  }
  if (!Array.isArray(state.playerRanks) || state.playerRanks.length < 2) {
    throw new Error('Advisor requires at least two visible player cards');
  }
  if (!Number.isInteger(state.dealerUpRank) || state.dealerUpRank < 0 || state.dealerUpRank > 9) {
    throw new Error('Advisor requires one visible dealer upcard');
  }

  const analysis = analyzeHand({
    dealer: RANK_LABELS[state.dealerUpRank],
    playerCards: state.playerRanks.map((rank) => RANK_LABELS[rank]),
    rules: VERIFIED_RULES,
  });

  return {
    action: analysis.recommendation,
    standEV: analysis.expectedValues.stand,
    hitEV: analysis.expectedValues.hit,
    ev: analysis.ev,
    ev2: analysis.ev2,
    total: analysis.playerTotal,
    soft: analysis.handType === 'soft',
    bust: analysis.recommendation === 'BUST',
  };
}

function handLabel(advice) {
  return `${advice.soft ? 'Soft' : 'Hard'} ${advice.total}`;
}

function formatAdviceMessage(state, advice, sourceLink = state.sourceLink) {
  const upcard = RANK_LABELS[state.dealerUpRank];
  const knownCards = state.playerRanks.length + 1;
  const lines = [];

  if (advice.bust) {
    lines.push('# BUST');
    lines.push(`**${handLabel(advice)}** vs dealer **${upcard}**`);
    lines.push(`Bust settlement EV: ${formatEV(advice.ev)}`);
    lines.push('No HIT or STAND decision remains.');
  } else {
    lines.push(`# ${advice.action}`);
    lines.push(`**${handLabel(advice)}** vs dealer **${upcard}**`);
    lines.push(`Stand EV: ${formatEV(advice.standEV)}`);
    lines.push(`Hit EV: ${formatEV(advice.hitEV)}`);
  }

  lines.push(`Known: ${knownCards} cards · dealer hole hidden`);
  if (sourceLink) lines.push(`[Open the OwO hand](${sourceLink})`);
  lines.push('-# Exact finite-deck EV · manual play only.');
  return lines.join('\n');
}

function formatEndedMessage(state) {
  return [
    '# HAND COMPLETE',
    `OwO: **${state.footerStatus}**`,
    'Tracking stopped for this hand.',
  ].join('\n');
}

function formatUnsupportedMessage(reason) {
  return [
    '# ADVICE PAUSED',
    `Unsupported OwO format: ${reason}`,
    'No recommendation was produced. The bot will not guess.',
  ].join('\n');
}

function formatAmbiguousMessage() {
  return [
    '# ADVICE PAUSED',
    'Another active OwO game is already being tracked in this channel.',
    'This version supports one active game per channel.',
  ].join('\n');
}

function formatExpiredMessage() {
  return [
    '# TRACKING STOPPED',
    'No OwO game update was seen before the session expired.',
    'Start a new hand in this channel when ready.',
  ].join('\n');
}

function formatDeletedMessage() {
  return [
    '# TRACKING STOPPED',
    'The OwO game message was deleted or is no longer available.',
  ].join('\n');
}

function formatStoppedMessage() {
  return [
    '# TRACKING STOPPED',
    'The companion was stopped with `/owo stop`.',
    'Start a new hand and run `/owo` when ready.',
  ].join('\n');
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—';
}

function formatAnalysis(analysis) {
  const lines = [
    `Dealer: ${analysis.dealer}${analysis.dealerSuit || ''}`,
    `Player: ${analysis.playerCards.join(' + ')}`,
    `Total: ${analysis.playerTotal}`,
    `Hand: ${analysis.handType.toUpperCase()}`,
    `Recommendation: ${analysis.recommendation || 'PENDING'}`,
  ];

  if (analysis.rules?.status === 'verified') {
    lines.push(
      'Rules: verified OwO (single 51-card deck, dealer stands soft 17, both-bust push, 1:1 natural, no double/split)'
    );
    if (analysis.rules.defaulted?.length) {
      lines.push(`Rules defaulted from verified source: ${analysis.rules.defaulted.join(', ')}`);
    }
  } else {
    lines.push(`Rules: ${analysis.rules?.status || 'pending'} — ${analysis.reason}`);
  }

  if (analysis.expectedValues.stand !== null) {
    lines.push(`STAND EV: ${formatEV(analysis.expectedValues.stand)}`);
    lines.push(`HIT EV: ${formatEV(analysis.expectedValues.hit)}`);
    lines.push(`Bust probability if hit: ${formatPercent(analysis.bustProbability)}`);
  }

  if (analysis.dealerOutcomes) {
    const outcomes = analysis.dealerOutcomes;
    lines.push(
      `Dealer final outcomes: 17 ${formatPercent(outcomes[17])}, 18 ${formatPercent(outcomes[18])}, ` +
        `19 ${formatPercent(outcomes[19])}, 20 ${formatPercent(outcomes[20])}, ` +
        `21 ${formatPercent(outcomes[21])}, bust ${formatPercent(outcomes.bust)}`
    );
  }

  if (analysis.remainingCards !== null) {
    lines.push(
      `Remaining unknown cards: ${analysis.remainingCards} (includes the hidden dealer hole)`
    );
    lines.push(
      `Remaining composition: ${RANK_LABELS.map(
        (rank) => `${rank}:${analysis.remainingComposition[rank]}`
      ).join(' ')}`
    );
  }

  lines.push(`Why: ${analysis.reason}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = {
    dealer: null,
    playerCards: [],
    observedCards: [],
    rules: 'verified',
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, inline] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, null];
    const value = () => {
      if (inline !== null) return inline;
      if (i + 1 >= argv.length) throw new AdvisorInputError(`${name} requires a value`);
      return argv[++i];
    };

    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (name === '--dealer') options.dealer = value();
    else if (name === '--cards') options.playerCards = value().split(',').filter(Boolean);
    else if (name === '--observed') options.observedCards = value().split(',').filter(Boolean);
    else if (name === '--rules') options.rules = value();
    else throw new AdvisorInputError(`Unknown argument: ${arg}`);
  }

  return options;
}

function cliUsage() {
  return [
    'Usage:',
    '  node blackjack-advisor.js --dealer 8 --cards 10,6',
    '  node blackjack-advisor.js --dealer 8 --cards 10,6 --json',
    '  node blackjack-advisor.js --dealer 8 --cards 10,6 --observed 2,3',
    '',
    'Options:',
    '  --dealer CARD       Dealer visible upcard (required)',
    '  --cards LIST        Comma-separated player cards (required, at least two)',
    '  --observed LIST     Additional known removed cards in this hand (optional)',
    '  --rules verified    Use the verified published OwO rules (default)',
    '  --json              Print machine-readable JSON',
    '  --help              Show this help',
    '',
    'Observed cards are for the current hand/shoe only. OwO resets the 51-card deck',
    'for each game; do not carry cards from a previous game into this field.',
  ].join('\n');
}

function runCli(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(cliUsage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(cliUsage());
    return;
  }

  if (!options.dealer || options.playerCards.length === 0) {
    console.error('Both --dealer and --cards are required.');
    console.error(cliUsage());
    process.exitCode = 2;
    return;
  }

  if (options.rules !== 'verified' && options.rules !== 'unknown') {
    console.error('--rules must be "verified" or "unknown".');
    process.exitCode = 2;
    return;
  }

  try {
    const analysis = analyzeHand({
      dealer: options.dealer,
      playerCards: options.playerCards,
      observedCards: options.observedCards,
      rules: options.rules === 'verified' ? VERIFIED_RULES : null,
    });
    if (options.json) console.log(JSON.stringify(analysis, null, 2));
    else console.log(formatAnalysis(analysis));
    if (analysis.confidence !== 'high') process.exitCode = 1;
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: { code: error.code || 'ERROR', message: error.message } }, null, 2));
    } else {
      console.error(`Error: ${error.message}`);
    }
    process.exitCode = 2;
  }
}

if (require.main === module) runCli();

module.exports = {
  AdvisorInputError,
  RANK_LABELS,
  VERIFIED_RULES,
  analyzeHand,
  advise,
  formatAnalysis,
  formatEV,
  formatAdviceMessage,
  formatEndedMessage,
  formatUnsupportedMessage,
  formatAmbiguousMessage,
  formatExpiredMessage,
  formatDeletedMessage,
  formatStoppedMessage,
  handLabel,
  normalizeRules,
  parseCard,
  parseCardList,
  runCli,
};
