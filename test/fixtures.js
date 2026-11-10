'use strict';

const { addRank } = require('../finite-deck-solver');
const { shownPoints } = require('../owo-blackjack-parser');

const DEFAULT_OWO_BOT_ID = '408785106942164992';

function cardEmoji(name, animated = false) {
  return `<${animated ? 'a' : ''}:${name}:123456789012345678>`;
}

function handTotal(names) {
  const ranks = names.map((name) => {
    const match = /^(a|2|3|4|5|6|7|8|9|10|j|q|k)[scdh]f?$/.exec(name);
    if (!match) throw new Error(`bad fixture card ${name}`);
    if (match[1] === 'a') return 0;
    if (['10', 'j', 'q', 'k'].includes(match[1])) return 9;
    return Number(match[1]) - 1;
  });
  let hand = { total: 0, soft: false };
  for (const rank of ranks) hand = addRank(hand.total, hand.soft, rank);
  return hand;
}

function makeOwOMessage({
  player = ['10s', '6h'],
  dealer = ['9c'],
  dealerHidden = true,
  footer = '🎲 ~ game in progress',
  playerTotal,
  playerSoft,
  dealerTotal,
  animated = [],
  authorId = DEFAULT_OWO_BOT_ID,
  channelId = 'channel-1',
  guildId = 'guild-1',
  id = 'message-1',
  createdTimestamp = 1000,
  editedTimestamp = null,
  embeds = null,
} = {}) {
  const playerHand = handTotal(player);
  const playerLabel = playerTotal ?? playerHand.total;
  const playerStar = playerSoft ?? playerHand.soft;
  const dealerLabel =
    dealerTotal === undefined
      ? dealerHidden
        ? shownPoints(
            dealer.map((name) => {
              const match = /^(a|2|3|4|5|6|7|8|9|10|j|q|k)[scdh]f?$/.exec(name);
              if (!match) throw new Error(`bad fixture dealer card ${name}`);
              if (match[1] === 'a') return 0;
              if (['10', 'j', 'q', 'k'].includes(match[1])) return 9;
              return Number(match[1]) - 1;
            })
          )
        : handTotal(dealer).total
      : dealerTotal;

  const dealerValue = dealer
    .map((name) => cardEmoji(name, animated.includes(name)))
    .concat(dealerHidden ? cardEmoji('cardback') : [])
    .join(' ');
  const playerValue = player
    .map((name) => cardEmoji(name, animated.includes(name)))
    .join(' ');

  const generatedEmbed = {
    author: { name: 'player, you bet 10 to play blackjack' },
    footer: { text: footer },
    fields: [
      {
        name: `Dealer \`[${dealerLabel}${dealerHidden ? '+?' : ''}]\``,
        value: dealerValue,
        inline: true,
      },
      {
        name: `player \`[${playerLabel}]${playerStar ? '*' : ''}\``,
        value: playerValue,
        inline: true,
      },
    ],
  };

  return {
    id,
    channelId,
    guildId,
    author: { id: authorId, bot: true },
    createdTimestamp,
    editedTimestamp,
    embeds: embeds || [generatedEmbed],
  };
}

function endedMessage(overrides = {}) {
  return makeOwOMessage({
    dealer: ['9c', '5d'],
    dealerHidden: false,
    footer: '🎲 ~ You won 20 cowoncy!',
    ...overrides,
  });
}

module.exports = {
  DEFAULT_OWO_BOT_ID,
  cardEmoji,
  handTotal,
  makeOwOMessage,
  endedMessage,
};
