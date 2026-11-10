'use strict';

const {
  advise,
  formatAdviceMessage,
  formatEndedMessage,
  formatUnsupportedMessage,
  formatAmbiguousMessage,
  formatExpiredMessage,
  formatDeletedMessage,
  formatStoppedMessage,
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

    // One active game per source channel. No persistent store, no card history.
    this.games = new Map();
    this.reported = new Map();
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
  messageVersion,
  signatureOf,
};
