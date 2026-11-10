'use strict';

/*
 * Parser for the published OwO blackjack embed.
 *
 * The parser is deliberately strict. If OwO's live message differs from the
 * audited format, it returns an unsupported result instead of guessing cards or
 * the dealer's hidden hole card.
 */

const { addRank } = require('./finite-deck-solver');

const DEFAULT_OWO_BOT_ID = '408785106942164992';
const RANK_LABELS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const CUSTOM_EMOJI_RE = /<a?:([A-Za-z0-9_]+):(\d+)>/g;
const CARD_NAME_RE = /^(a|2|3|4|5|6|7|8|9|10|j|q|k)([scdh])(f?)$/;
const BLACKJACK_FOOTER_RE = /^🎲\s*~/u;

class ParserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ParserError';
    this.code = code;
  }
}

function fail(code, message) {
  return { ok: false, code, reason: message };
}

function isBlackjackCandidate(embed) {
  const footer = embed?.footer?.text || '';
  const fields = Array.isArray(embed?.fields) ? embed.fields : [];
  return (
    BLACKJACK_FOOTER_RE.test(footer) ||
    fields.some((field) => /^Dealer\b/i.test(String(field?.name || ''))) ||
    /blackjack/i.test(String(embed?.author?.name || ''))
  );
}

function cardRankFromName(name) {
  if (name === 'cardback') return { hidden: true };

  const match = CARD_NAME_RE.exec(name);
  if (!match) {
    throw new ParserError('UNSUPPORTED_CARD', `Unrecognized card emoji "${name}"`);
  }

  const [, face, suit] = match;
  if (face === '7' && suit === 'h') {
    throw new ParserError(
      'RULES_MISMATCH',
      'OwO displayed 7h, but the published 51-card deck omits 7♥'
    );
  }

  let rank;
  if (face === 'a') rank = 0;
  else if (face === '10' || face === 'j' || face === 'q' || face === 'k') rank = 9;
  else {
    rank = Number(face) - 1;
    if (!Number.isInteger(rank) || rank < 1 || rank > 8) {
      throw new ParserError('UNSUPPORTED_CARD', `Unrecognized card rank "${face}"`);
    }
  }

  return { rank, hidden: false };
}

function parseCardField(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ParserError('UNSUPPORTED_LAYOUT', `${fieldName} has no card value`);
  }

  const ranks = [];
  let hidden = 0;
  const remaining = value.replace(CUSTOM_EMOJI_RE, (_whole, name) => {
    const card = cardRankFromName(name);
    if (card.hidden) {
      hidden++;
    } else {
      ranks.push(card.rank);
    }
    return '';
  });

  if (remaining.replace(/\s+/g, '') !== '') {
    throw new ParserError(
      'UNSUPPORTED_LAYOUT',
      `${fieldName} contains text or a non-card emoji`
    );
  }

  return { ranks, hidden };
}

function totalRanks(ranks) {
  let hand = { total: 0, soft: false };
  for (const rank of ranks) {
    hand = addRank(hand.total, hand.soft, rank);
  }
  return hand;
}

function shownPoints(ranks) {
  // OwO's in-progress dealer label uses cardValue(...).shownPoints, which
  // counts a visible ace as 1 rather than 11. The final label uses points.
  return ranks.reduce((total, rank) => total + (rank === 0 ? 1 : rank === 9 ? 10 : rank + 1), 0);
}

function parseFooterStatus(footer) {
  const match = String(footer || '').match(/^🎲\s*~\s*(.+)$/u);
  if (!match) {
    throw new ParserError('UNSUPPORTED_LAYOUT', 'Blackjack embed has no recognized footer');
  }

  const status = match[1].trim();
  if (status === 'game in progress' || status === 'resuming previous game') {
    return { phase: 'in_progress', status };
  }
  if (
    status.startsWith('You won') ||
    status.startsWith('You lost') ||
    status.startsWith('You tied') ||
    status.startsWith('You both bust')
  ) {
    return { phase: 'ended', status };
  }

  throw new ParserError('UNSUPPORTED_LAYOUT', `Unrecognized game status "${status}"`);
}

function parseOwOBlackjackMessage(message, options = {}) {
  const owoBotId = options.owoBotId || DEFAULT_OWO_BOT_ID;
  const authorId = message?.author?.id;
  if (authorId && authorId !== owoBotId) {
    return fail('NOT_BLACKJACK', 'Message was not authored by the configured OwO bot');
  }

  const embeds = Array.isArray(message?.embeds)
    ? message.embeds
    : Array.from(message?.embeds || []);
  if (embeds.length !== 1) {
    if (embeds.some(isBlackjackCandidate)) {
      return fail('UNSUPPORTED_LAYOUT', 'Expected exactly one blackjack embed');
    }
    return fail('NOT_BLACKJACK', 'Message is not a blackjack embed');
  }

  const embed = embeds[0];
  if (!isBlackjackCandidate(embed)) {
    return fail('NOT_BLACKJACK', 'Message is not a blackjack embed');
  }

  const messageId = message?.id;
  const channelId = message?.channelId || message?.channel?.id;
  if (!messageId || !channelId) {
    return fail('UNSUPPORTED_LAYOUT', 'Blackjack message is missing an ID or channel ID');
  }

  const fields = Array.isArray(embed.fields) ? embed.fields : [];
  if (fields.length !== 2) {
    return fail('UNSUPPORTED_LAYOUT', 'Expected exactly two blackjack embed fields');
  }

  const dealerFields = fields.filter((field) => /^Dealer\b/i.test(String(field?.name || '')));
  const playerFields = fields.filter((field) => !/^Dealer\b/i.test(String(field?.name || '')));
  if (dealerFields.length !== 1 || playerFields.length !== 1) {
    return fail('UNSUPPORTED_LAYOUT', 'Could not identify exactly one dealer and player field');
  }

  const dealerField = dealerFields[0];
  const playerField = playerFields[0];

  let footer;
  try {
    footer = parseFooterStatus(embed?.footer?.text);
  } catch (error) {
    if (error instanceof ParserError) return fail(error.code, error.message);
    throw error;
  }

  const dealerTotalMatch = String(dealerField.name).match(/\[(\d+)(\+\?)?\]/);
  if (!dealerTotalMatch) {
    return fail('UNSUPPORTED_LAYOUT', 'Dealer field has no displayed total');
  }
  const dealerShownTotal = Number(dealerTotalMatch[1]);
  const dealerTotalHidden = Boolean(dealerTotalMatch[2]);

  // The published source renders a soft hand as `[14]*`, with the star after
  // the closing bracket and before the closing backtick.
  const playerTotalMatches = [
    ...String(playerField.name).matchAll(/\[(\d{1,2})\]\s*(\*?)\s*`?\s*$/g),
  ];
  if (playerTotalMatches.length !== 1) {
    return fail('UNSUPPORTED_LAYOUT', 'Player field has no unambiguous displayed total');
  }
  const playerLabelTotal = Number(playerTotalMatches[0][1]);
  const playerLabelSoft = playerTotalMatches[0][2] === '*';

  let dealerCards;
  let playerCards;
  try {
    dealerCards = parseCardField(dealerField.value, 'Dealer field');
    playerCards = parseCardField(playerField.value, 'Player field');
  } catch (error) {
    if (error instanceof ParserError) return fail(error.code, error.message);
    throw error;
  }

  if (playerCards.hidden > 0) {
    return fail('HIDDEN_PLAYER_CARD', 'A player card is hidden; visible state is incomplete');
  }
  if (playerCards.ranks.length < 2) {
    return fail('UNSUPPORTED_LAYOUT', 'Expected at least two visible player cards');
  }

  if (footer.phase === 'in_progress') {
    if (dealerCards.hidden !== 1) {
      return fail(
        'UNSUPPORTED_LAYOUT',
        'Expected exactly one hidden dealer hole card during play'
      );
    }
    if (dealerCards.ranks.length !== 1) {
      return fail(
        'UNSUPPORTED_LAYOUT',
        'Expected exactly one visible dealer upcard during play'
      );
    }
    if (!dealerTotalHidden) {
      return fail(
        'UNSUPPORTED_LAYOUT',
        'Dealer total no longer shows an unknown hole during play'
      );
    }
  } else {
    if (dealerCards.hidden !== 0) {
      return fail('UNSUPPORTED_LAYOUT', 'Completed hand still hides a dealer card');
    }
    if (dealerCards.ranks.length < 2) {
      return fail('UNSUPPORTED_LAYOUT', 'Completed hand has too few dealer cards');
    }
    if (dealerTotalHidden) {
      return fail('UNSUPPORTED_LAYOUT', 'Completed hand still shows an unknown dealer total');
    }
  }

  const playerHand = totalRanks(playerCards.ranks);
  if (playerHand.total !== playerLabelTotal || playerHand.soft !== playerLabelSoft) {
    return fail(
      'TOTAL_MISMATCH',
      `Player cards total ${playerHand.total}${playerHand.soft ? ' soft' : ''}, ` +
        `but OwO displays ${playerLabelTotal}${playerLabelSoft ? ' soft' : ''}`
    );
  }

  const dealerHand = totalRanks(dealerCards.ranks);
  const dealerLabelPoints =
    footer.phase === 'in_progress' ? shownPoints(dealerCards.ranks) : dealerHand.total;
  if (dealerLabelPoints !== dealerShownTotal) {
    return fail(
      'TOTAL_MISMATCH',
      `Visible dealer cards total ${dealerLabelPoints}, but OwO displays ${dealerShownTotal}`
    );
  }

  const guildId = message?.guildId || message?.guild?.id || null;
  const sourceLink =
    guildId && channelId && messageId
      ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
      : null;

  const state = {
    messageId,
    channelId,
    guildId,
    phase: footer.phase,
    footerStatus: footer.status,
    playerRanks: playerCards.ranks.slice(),
    playerTotal: playerHand.total,
    playerSoft: playerHand.soft,
    dealerVisibleRanks: dealerCards.ranks.slice(),
    dealerUpRank: footer.phase === 'in_progress' ? dealerCards.ranks[0] : null,
    dealerVisibleTotal: dealerLabelPoints,
    dealerHiddenCount: dealerCards.hidden,
    sourceLink,
  };

  return {
    ok: true,
    state,
    labels: {
      dealerUp: state.dealerUpRank === null ? null : RANK_LABELS[state.dealerUpRank],
      player: RANK_LABELS,
    },
  };
}

module.exports = {
  DEFAULT_OWO_BOT_ID,
  RANK_LABELS,
  parseOwOBlackjackMessage,
  parseFooterStatus,
  parseCardField,
  cardRankFromName,
  totalRanks,
  shownPoints,
};
