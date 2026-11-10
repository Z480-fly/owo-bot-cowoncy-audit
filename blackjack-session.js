'use strict';

const {
  AdvisorInputError,
  RANK_LABELS,
  VERIFIED_RULES,
  advise,
  analyzeHand,
  formatAdviceMessage,
  formatEndedMessage,
  formatUnsupportedMessage,
  formatAmbiguousMessage,
  formatExpiredMessage,
  formatDeletedMessage,
  formatStoppedMessage,
  parseCard,
} = require('./blackjack-advisor');
const { parseOwOBlackjackMessage, DEFAULT_OWO_BOT_ID } = require('./owo-blackjack-parser');

function messageVersion(message) {
  const raw =
    message?.editedTimestamp ??
    message?.edited_timestamp ??
    message?.createdTimestamp ??
    message?.created_timestamp ??
    0;

  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function signatureOf(state) {
  return JSON.stringify({
    messageId: state.messageId,
    phase: state.phase,
    playerRanks: state.playerRanks,
    dealerVisibleRanks: state.dealerVisibleRanks,
    dealerUpRank: state.dealerUpRank,
    playerTotal: state.playerTotal,
    playerSoft: state.playerSoft,
    dealerVisibleTotal: state.dealerVisibleTotal,
    footerStatus: state.footerStatus,
  });
}

function normalizeOutcome(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('both bust') || text.includes('both-bust')) return 'push';
  if (text.includes('won') || text.includes('win')) return 'win';
  if (text.includes('lost') || text.includes('loss')) return 'loss';
  if (text.includes('tied') || text.includes('tie') || text.includes('push')) return 'push';
  throw new AdvisorInputError(
    'Result must be win, loss, or push (both-bust is a push)',
    'INVALID_RESULT'
  );
}

function outcomeFromFooter(footerStatus) {
  return normalizeOutcome(footerStatus);
}

function emptyBucket() {
  return {
    hands: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    hitRecommendations: 0,
    standRecommendations: 0,
  };
}

function addToBucket(bucket, record) {
  bucket.hands++;
  if (record.outcome === 'win') bucket.wins++;
  else if (record.outcome === 'loss') bucket.losses++;
  else bucket.pushes++;
  if (record.recommendation === 'HIT') bucket.hitRecommendations++;
  if (record.recommendation === 'STAND') bucket.standRecommendations++;
}

/*
 * Aggregate results without conflating outcome with decision quality. A HIT or
 * STAND is not “correct” merely because it won; accuracy is reported only when
 * a caller explicitly marks a recommendation as correct or incorrect.
 */
class BlackjackStats {
  constructor() {
    this.records = [];
    this.correct = 0;
    this.incorrect = 0;
    this.followed = 0;
    this.notFollowed = 0;
  }

  record({
    outcome,
    recommendation = null,
    playerTotal = null,
    handType = null,
    dealer = null,
    recommendationCorrect = null,
    followedRecommendation = null,
  }) {
    const normalized = normalizeOutcome(outcome);
    const record = {
      outcome: normalized,
      recommendation,
      playerTotal,
      handType,
      dealer,
      recommendationCorrect:
        typeof recommendationCorrect === 'boolean' ? recommendationCorrect : null,
      followedRecommendation:
        typeof followedRecommendation === 'boolean' ? followedRecommendation : null,
    };

    if (record.recommendationCorrect === true) this.correct++;
    if (record.recommendationCorrect === false) this.incorrect++;
    if (record.followedRecommendation === true) this.followed++;
    if (record.followedRecommendation === false) this.notFollowed++;
    this.records.push(record);
    return record;
  }

  summary() {
    const totals = emptyBucket();
    const byDealerUpcard = {};
    const byHandType = {};

    for (const record of this.records) {
      addToBucket(totals, record);
      const dealerKey = record.dealer || 'unknown';
      byDealerUpcard[dealerKey] ||= emptyBucket();
      addToBucket(byDealerUpcard[dealerKey], record);
      const typeKey = record.handType || 'unknown';
      byHandType[typeKey] ||= emptyBucket();
      addToBucket(byHandType[typeKey], record);
    }

    const resolved = totals.wins + totals.losses + totals.pushes;
    const accuracySamples = this.correct + this.incorrect;
    const followSamples = this.followed + this.notFollowed;
    return {
      hands: totals.hands,
      wins: totals.wins,
      losses: totals.losses,
      pushes: totals.pushes,
      winRate: resolved > 0 ? totals.wins / resolved : null,
      hitRecommendations: totals.hitRecommendations,
      standRecommendations: totals.standRecommendations,
      recommendationAccuracy: accuracySamples > 0 ? this.correct / accuracySamples : null,
      recommendationAccuracySamples: accuracySamples,
      recommendationFollowRate: followSamples > 0 ? this.followed / followSamples : null,
      recommendationFollowSamples: followSamples,
      byDealerUpcard,
      byHandType,
    };
  }
}

class BlackjackTableTracker {
  constructor({ rules = VERIFIED_RULES, now = () => Date.now() } = {}) {
    this.rules = rules;
    this.now = now;
    this.stats = new BlackjackStats();
    this.history = [];
    this.handNumber = 0;
    this.dealer = null;
    this.playerCards = [];
    this.observedCards = [];
    this.lastAnalysis = null;
  }

  _assertUnique(card, cards, label) {
    if (!card.identity) return;
    for (const existing of cards) {
      if (existing.identity === card.identity) {
        throw new AdvisorInputError(
          `Duplicate card registration: ${label} already contains ${card.label}${card.suit}`,
          'DUPLICATE_CARD'
        );
      }
    }
  }

  _visibleCards() {
    return [this.dealer, ...this.playerCards, ...this.observedCards].filter(Boolean);
  }

  _cardInput(card) {
    return card.label + (card.suit || '');
  }

  beginHand({ dealer, playerCards, observedCards = [] }) {
    const parsedDealer = parseCard(dealer, 'dealer');
    const parsedPlayers = (Array.isArray(playerCards) ? playerCards : [playerCards]).map(
      (card, index) => parseCard(card, `playerCards[${index}]`)
    );
    const parsedObserved = (Array.isArray(observedCards) ? observedCards : [observedCards])
      .filter((card) => card !== undefined && card !== null && card !== '')
      .map((card, index) => parseCard(card, `observedCards[${index}]`));

    const all = [parsedDealer, ...parsedPlayers, ...parsedObserved];
    const seen = new Set();
    for (const card of all) {
      if (!card.identity) continue;
      if (seen.has(card.identity)) {
        throw new AdvisorInputError(
          `Duplicate card registration: ${card.label}${card.suit}`,
          'DUPLICATE_CARD'
        );
      }
      seen.add(card.identity);
    }

    this.dealer = parsedDealer;
    this.playerCards = parsedPlayers;
    this.observedCards = parsedObserved;
    this.lastAnalysis = null;
    this.handNumber++;
    try {
      return this.analyze();
    } catch (error) {
      this.clearHand();
      throw error;
    }
  }

  setDealer(card) {
    const parsed = parseCard(card, 'dealer');
    this._assertUnique(parsed, [...this.playerCards, ...this.observedCards], 'visible cards');
    const previous = this.dealer;
    this.dealer = parsed;
    this.lastAnalysis = null;
    try {
      return this.analyze();
    } catch (error) {
      this.dealer = previous;
      throw error;
    }
  }

  addPlayerCard(card) {
    const parsed = parseCard(card, 'player card');
    this._assertUnique(parsed, this._visibleCards(), 'visible cards');
    this.playerCards.push(parsed);
    this.lastAnalysis = null;
    try {
      return this.analyze();
    } catch (error) {
      this.playerCards.pop();
      throw error;
    }
  }

  addObservedCard(card) {
    const parsed = parseCard(card, 'observed card');
    this._assertUnique(parsed, this._visibleCards(), 'visible cards');
    this.observedCards.push(parsed);
    this.lastAnalysis = null;
    try {
      return this.analyze();
    } catch (error) {
      this.observedCards.pop();
      throw error;
    }
  }

  replacePlayerCard(index, card) {
    if (!Number.isInteger(index) || index < 0 || index >= this.playerCards.length) {
      throw new AdvisorInputError('playerCards index is out of range', 'INVALID_INDEX');
    }
    const parsed = parseCard(card, 'player card');
    const others = [this.dealer, ...this.playerCards.filter((_item, i) => i !== index), ...this.observedCards];
    this._assertUnique(parsed, others.filter(Boolean), 'visible cards');
    const previous = this.playerCards[index];
    this.playerCards[index] = parsed;
    this.lastAnalysis = null;
    try {
      return this.analyze();
    } catch (error) {
      this.playerCards[index] = previous;
      throw error;
    }
  }

  replaceObservedCard(index, card) {
    if (!Number.isInteger(index) || index < 0 || index >= this.observedCards.length) {
      throw new AdvisorInputError('observedCards index is out of range', 'INVALID_INDEX');
    }
    const parsed = parseCard(card, 'observed card');
    const others = [this.dealer, ...this.playerCards, ...this.observedCards.filter((_item, i) => i !== index)];
    this._assertUnique(parsed, others.filter(Boolean), 'visible cards');
    const previous = this.observedCards[index];
    this.observedCards[index] = parsed;
    this.lastAnalysis = null;
    try {
      return this.analyze();
    } catch (error) {
      this.observedCards[index] = previous;
      throw error;
    }
  }

  correctCard({ zone, index, card }) {
    if (zone === 'dealer') return this.setDealer(card);
    if (zone === 'player') return this.replacePlayerCard(index, card);
    if (zone === 'observed') return this.replaceObservedCard(index, card);
    throw new AdvisorInputError('zone must be dealer, player, or observed', 'INVALID_ZONE');
  }

  analyze() {
    if (!this.dealer) throw new AdvisorInputError('Register the dealer upcard first', 'MISSING_CARDS');
    if (this.playerCards.length < 2) {
      throw new AdvisorInputError('At least two player cards are required', 'MISSING_CARDS');
    }

    const analysis = analyzeHand({
      dealer: this._cardInput(this.dealer),
      playerCards: this.playerCards.map((card) => this._cardInput(card)),
      observedCards: this.observedCards.map((card) => this._cardInput(card)),
      rules: this.rules,
    });
    this.lastAnalysis = analysis;
    return analysis;
  }

  recordResult({
    outcome,
    recommendationCorrect = null,
    followedRecommendation = null,
    at = this.now(),
  } = {}) {
    const analysis = this.lastAnalysis || this.analyze();
    const record = this.stats.record({
      outcome,
      recommendation: analysis.recommendation,
      playerTotal: analysis.playerTotal,
      handType: analysis.handType,
      dealer: analysis.dealer,
      recommendationCorrect,
      followedRecommendation,
    });
    this.history.push({
      handNumber: this.handNumber,
      at,
      dealer: analysis.dealer,
      playerCards: analysis.playerCards.slice(),
      observedCards: analysis.observedCards.slice(),
      playerTotal: analysis.playerTotal,
      handType: analysis.handType,
      recommendation: analysis.recommendation,
      expectedValues: { ...analysis.expectedValues },
      ...record,
    });
    return this.stats.summary();
  }

  getStats() {
    return this.stats.summary();
  }

  getHistory() {
    return this.history.slice();
  }

  clearHand() {
    this.dealer = null;
    this.playerCards = [];
    this.observedCards = [];
    this.lastAnalysis = null;
  }
}

class BlackjackSessionManager {
  constructor({
    sink,
    trackedChannelIds = [],
    owoBotId = DEFAULT_OWO_BOT_ID,
    idleMs = 90_000,
    now = () => Date.now(),
    logger = console,
  }) {
    if (
      !sink ||
      typeof sink.upsert !== 'function' ||
      typeof sink.report !== 'function'
    ) {
      throw new Error('Session manager requires a sink with upsert() and report()');
    }

    this.sink = sink;
    this.trackedChannelIds = new Set(trackedChannelIds);
    this.owoBotId = owoBotId;
    this.idleMs = Number.isFinite(idleMs) && idleMs > 0 ? idleMs : 90_000;
    this.now = now;
    this.logger = logger;

    // One active game per source channel. History is in memory only.
    this.games = new Map();
    this.reported = new Map();
    this.stats = new BlackjackStats();
    this.history = [];
  }

  _handMeta(state, advice) {
    return {
      dealer: RANK_LABELS[state.dealerUpRank],
      playerCards: state.playerRanks.map((rank) => RANK_LABELS[rank]),
      observedCards: [],
      playerTotal: advice.total,
      handType: advice.soft ? 'soft' : 'hard',
      recommendation: advice.action,
      expectedValues: { hit: advice.hitEV, stand: advice.standEV },
    };
  }

  _recordCompleted(session, state) {
    if (!session?.hand) return null;
    try {
      const record = this.stats.record({
        ...session.hand,
        outcome: outcomeFromFooter(state.footerStatus),
        recommendationCorrect: null,
        followedRecommendation: null,
      });
      this.history.push({
        ...session.hand,
        ...record,
        sourceMessageId: session.sourceMessageId,
        footerStatus: state.footerStatus,
        at: this.now(),
      });
      return record;
    } catch (error) {
      this.logger.error?.('[session] Could not record completed hand:', error.message);
      return null;
    }
  }

  getStats() {
    return this.stats.summary();
  }

  getHistory() {
    return this.history.slice();
  }

  _isTracked(channelId) {
    return Boolean(channelId && this.trackedChannelIds.has(channelId));
  }

  _markReported(key) {
    const now = this.now();
    if (this.reported.has(key)) return false;
    this.reported.set(key, now);

    // Bound the warning cache without retaining gameplay history.
    if (this.reported.size > 500) {
      for (const [oldKey, oldTime] of this.reported) {
        if (now - oldTime > 300_000 || this.reported.size > 500) {
          this.reported.delete(oldKey);
        }
      }
    }
    return true;
  }

  async _reportOnce(channelId, key, content) {
    if (!this._markReported(`${channelId}:${key}`)) return false;
    try {
      await this.sink.report(channelId, content);
    } catch (error) {
      this.logger.error?.('[session] Could not report warning:', error.message);
    }
    return true;
  }

  async _pause(channelId, session, content) {
    try {
      session.adviceMessageId = await this.sink.upsert(
        channelId,
        session.adviceMessageId,
        content
      );
    } catch (error) {
      this.logger.error?.('[session] Could not update advice message:', error.message);
    }
    this.games.delete(channelId);
  }

  activateChannel(channelId) {
    if (!channelId) throw new Error('A channel ID is required');
    const alreadyActive = this.trackedChannelIds.has(channelId);
    this.trackedChannelIds.add(channelId);
    return { active: true, alreadyActive };
  }

  async deactivateChannel(channelId) {
    const session = this.games.get(channelId);
    const wasActive = this.trackedChannelIds.has(channelId);
    this.trackedChannelIds.delete(channelId);
    if (!session) return { hadGame: false, wasActive };

    await this._pause(channelId, session, formatStoppedMessage());
    return { hadGame: true, wasActive };
  }

  getChannelStatus(channelId) {
    const session = this.games.get(channelId);
    return {
      active: this._isTracked(channelId),
      hasGame: Boolean(session),
      sourceMessageId: session?.sourceMessageId || null,
    };
  }

  async _handleUnsupported(channelId, message, parsed) {
    const session = this.games.get(channelId);
    if (session && session.sourceMessageId === message.id) {
      await this._pause(channelId, session, formatUnsupportedMessage(parsed.reason));
      return { status: 'unsupported', reason: parsed.reason };
    }

    if (!session) {
      await this._reportOnce(
        channelId,
        `${message.id}:${parsed.code}:${parsed.reason}`,
        formatUnsupportedMessage(parsed.reason)
      );
      return { status: 'unsupported', reason: parsed.reason };
    }

    // A different OwO message is not allowed to take over an active game.
    return { status: 'ignored', reason: 'unsupported message while another game is active' };
  }

  async _start(channelId, message, state, version) {
    let advice;
    try {
      advice = advise(state);
    } catch (error) {
      await this._reportOnce(
        channelId,
        `${message.id}:advisor:${error.message}`,
        formatUnsupportedMessage(error.message)
      );
      return { status: 'unsupported', reason: error.message };
    }

    const content = formatAdviceMessage(state, advice);
    let adviceMessageId;
    try {
      adviceMessageId = await this.sink.upsert(channelId, null, content);
    } catch (error) {
      this.logger.error?.('[session] Could not send initial advice:', error.message);
      return { status: 'error', reason: error.message };
    }

    this.games.set(channelId, {
      sourceMessageId: state.messageId,
      adviceMessageId,
      version,
      signature: signatureOf(state),
      hand: this._handMeta(state, advice),
      lastActivity: this.now(),
      createdAt: this.now(),
    });

    return { status: 'started', adviceMessageId };
  }

  async handleMessage(message) {
    const channelId = message?.channelId || message?.channel?.id;
    if (!this._isTracked(channelId)) {
      return { status: 'ignored', reason: 'channel is not tracked' };
    }

    await this.expireStale();

    const parsed = parseOwOBlackjackMessage(message, { owoBotId: this.owoBotId });
    if (!parsed.ok) {
      if (parsed.code === 'NOT_BLACKJACK') {
        return { status: 'ignored', reason: 'not a blackjack message' };
      }
      return this._handleUnsupported(channelId, message, parsed);
    }

    const state = parsed.state;
    const version = messageVersion(message);
    const session = this.games.get(channelId);

    if (!session) {
      if (state.phase !== 'in_progress') {
        return { status: 'ignored', reason: 'completed hand without an active session' };
      }
      return this._start(channelId, message, state, version);
    }

    if (session.sourceMessageId !== state.messageId) {
      if (state.phase === 'in_progress') {
        await this._reportOnce(
          channelId,
          `${message.id}:ambiguous`,
          formatAmbiguousMessage()
        );
        return { status: 'ambiguous', reason: 'another active game is already tracked' };
      }
      return { status: 'ignored', reason: 'completed hand from a different message' };
    }

    const signature = signatureOf(state);
    if (version < session.version) {
      return { status: 'stale', reason: 'older edit than the current state' };
    }
    if (version === session.version && signature === session.signature) {
      return { status: 'duplicate' };
    }

    session.version = Math.max(session.version, version);
    session.signature = signature;
    session.lastActivity = this.now();

    if (state.phase === 'ended') {
      this._recordCompleted(session, state);
      try {
        await this.sink.upsert(
          channelId,
          session.adviceMessageId,
          formatEndedMessage(state)
        );
      } catch (error) {
        this.logger.error?.('[session] Could not finalize advice:', error.message);
      }
      this.games.delete(channelId);
      return { status: 'ended' };
    }

    let advice;
    try {
      advice = advise(state);
    } catch (error) {
      await this._pause(channelId, session, formatUnsupportedMessage(error.message));
      return { status: 'unsupported', reason: error.message };
    }

    session.hand = this._handMeta(state, advice);
    try {
      session.adviceMessageId = await this.sink.upsert(
        channelId,
        session.adviceMessageId,
        formatAdviceMessage(state, advice)
      );
    } catch (error) {
      this.logger.error?.('[session] Could not edit advice:', error.message);
      return { status: 'error', reason: error.message };
    }

    return { status: 'updated', adviceMessageId: session.adviceMessageId };
  }

  async handleDelete(channelId, messageId) {
    const session = this.games.get(channelId);
    if (!session || session.sourceMessageId !== messageId) {
      return { status: 'ignored', reason: 'message is not the active game' };
    }

    await this._pause(channelId, session, formatDeletedMessage());
    return { status: 'deleted' };
  }

  async expireStale() {
    const now = this.now();
    for (const [channelId, session] of this.games) {
      if (now - session.lastActivity <= this.idleMs) continue;
      await this._pause(channelId, session, formatExpiredMessage());
    }
  }
}

module.exports = {
  BlackjackSessionManager,
  BlackjackStats,
  BlackjackTableTracker,
  messageVersion,
  normalizeOutcome,
  outcomeFromFooter,
  signatureOf,
};
