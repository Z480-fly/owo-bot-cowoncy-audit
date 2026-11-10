'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseOwOBlackjackMessage,
  shownPoints,
} = require('../owo-blackjack-parser');
const {
  DEFAULT_OWO_BOT_ID,
  cardEmoji,
  makeOwOMessage,
  endedMessage,
} = require('./fixtures');

function parse(message) {
  return parseOwOBlackjackMessage(message, { owoBotId: DEFAULT_OWO_BOT_ID });
}

test('parses the initial in-progress hand and ignores the dealer hole', () => {
  const parsed = parse(makeOwOMessage());
  assert.equal(parsed.ok, true);
  const state = parsed.state;

  assert.deepEqual(state.playerRanks, [9, 5]);
  assert.equal(state.playerTotal, 16);
  assert.equal(state.playerSoft, false);
  assert.equal(state.dealerUpRank, 8);
  assert.equal(state.dealerVisibleTotal, 9);
  assert.equal(state.dealerHiddenCount, 1);
  assert.deepEqual(state.dealerVisibleRanks, [8]);
  assert.equal(state.phase, 'in_progress');
  assert.equal(state.messageId, 'message-1');
  assert.equal(state.channelId, 'channel-1');
  assert.equal(state.sourceLink, 'https://discord.com/channels/guild-1/channel-1/message-1');
});

test('parses an animated hit card and updates the total', () => {
  const parsed = parse(
    makeOwOMessage({
      player: ['10s', '6h', '2c'],
      animated: ['2c'],
      editedTimestamp: 2000,
    })
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.state.playerRanks, [9, 5, 1]);
  assert.equal(parsed.state.playerTotal, 18);
});

test('accepts four aces and preserves a soft total', () => {
  const parsed = parse(
    makeOwOMessage({
      player: ['as', 'ah', 'ac', 'ad'],
      dealer: ['9c'],
    })
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.playerTotal, 14);
  assert.equal(parsed.state.playerSoft, true);
});

test('accepts three sevens from the published 51-card deck', () => {
  const parsed = parse(
    makeOwOMessage({
      player: ['7s', '7c', '7d'],
      dealer: ['2c'],
    })
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.playerTotal, 21);
});

test('accepts an ace as the visible dealer upcard with OwO shown-points label', () => {
  const parsed = parse(makeOwOMessage({ dealer: ['as'] }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.dealerUpRank, 0);
  assert.equal(parsed.state.dealerVisibleTotal, 1);
  assert.equal(parsed.state.dealerHiddenCount, 1);
  assert.equal(shownPoints([0]), 1);
});

test('parses an ended hand without producing an upcard', () => {
  const parsed = parse(endedMessage());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.phase, 'ended');
  assert.equal(parsed.state.dealerUpRank, null);
  assert.deepEqual(parsed.state.dealerVisibleRanks, [8, 4]);
  assert.equal(parsed.state.dealerHiddenCount, 0);
});

test('rejects 7h because the audited deck has no 7h', () => {
  const parsed = parse(
    makeOwOMessage({
      player: ['7h', '7s'],
      dealer: ['9c'],
    })
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'RULES_MISMATCH');
});

test('rejects a hidden player card', () => {
  const message = makeOwOMessage();
  message.embeds[0].fields[1].value += ` ${cardEmoji('cardback')}`;
  const parsed = parse(message);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'HIDDEN_PLAYER_CARD');
});

test('rejects an unknown card emoji', () => {
  const message = makeOwOMessage();
  message.embeds[0].fields[1].value = `<:mystery:123456789012345678>`;
  const parsed = parse(message);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'UNSUPPORTED_CARD');
});

test('rejects unexpected text in a card field', () => {
  const message = makeOwOMessage();
  message.embeds[0].fields[0].value += ' +?';
  const parsed = parse(message);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'UNSUPPORTED_LAYOUT');
});

test('rejects a displayed total that disagrees with the visible cards', () => {
  const parsed = parse(makeOwOMessage({ playerTotal: 20 }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'TOTAL_MISMATCH');
});

test('rejects a soft marker that disagrees with the visible cards', () => {
  const parsed = parse(
    makeOwOMessage({
      player: ['as', '6h'],
      playerSoft: false,
    })
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'TOTAL_MISMATCH');
});

test('rejects two visible dealer cards during play', () => {
  const parsed = parse(
    makeOwOMessage({
      dealer: ['9c', '5d'],
    })
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'UNSUPPORTED_LAYOUT');
});

test('rejects a missing dealer hole during play', () => {
  const parsed = parse(
    makeOwOMessage({
      dealer: ['9c'],
      dealerHidden: false,
    })
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'UNSUPPORTED_LAYOUT');
});

test('rejects an ended hand that still hides a dealer card', () => {
  const parsed = parse(
    endedMessage({
      dealer: ['9c', '5d'],
      dealerHidden: true,
    })
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'UNSUPPORTED_LAYOUT');
});

test('rejects an unknown footer status', () => {
  const parsed = parse(makeOwOMessage({ footer: '🎲 ~ something new' }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'UNSUPPORTED_LAYOUT');
});

test('rejects multiple embeds when one looks like blackjack', () => {
  const message = makeOwOMessage();
  message.embeds.push(makeOwOMessage({ id: 'message-2' }).embeds[0]);
  const parsed = parse(message);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'UNSUPPORTED_LAYOUT');
});

test('rejects a message from a different bot', () => {
  const parsed = parse(makeOwOMessage({ authorId: '999999999999999999' }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'NOT_BLACKJACK');
});

test('ignores an ordinary non-blackjack embed', () => {
  const message = makeOwOMessage({
    embeds: [
      {
        author: { name: 'OwO' },
        footer: { text: 'hunt result' },
        fields: [{ name: 'Animal', value: 'cat' }],
      },
    ],
  });
  const parsed = parse(message);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'NOT_BLACKJACK');
});

test('rejects a blackjack-shaped message with no displayed player total', () => {
  const message = makeOwOMessage();
  message.embeds[0].fields[1].name = 'player';
  const parsed = parse(message);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'UNSUPPORTED_LAYOUT');
});
