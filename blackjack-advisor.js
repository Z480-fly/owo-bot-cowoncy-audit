'use strict';

const { createVisibleEvaluator } = require('./finite-deck-solver');

const RANK_LABELS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

// One evaluator keeps the solver's exact dynamic-programming memoization.
const evaluateVisible = createVisibleEvaluator('51-push');

function formatEV(value) {
  if (!Number.isFinite(value)) return '—';
  return value >= 0 ? `+${value.toFixed(4)}` : value.toFixed(4);
}

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

  const result = evaluateVisible(state.playerRanks.slice(), state.dealerUpRank);
  return {
    action: result.bust ? 'BUST' : result.action === 'hit' ? 'HIT' : 'STAND',
    standEV: result.standEV,
    hitEV: result.hitEV,
    ev: result.ev,
    ev2: result.ev2,
    total: result.total,
    soft: result.soft,
    bust: result.bust,
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

module.exports = {
  advise,
  formatEV,
  formatAdviceMessage,
  formatEndedMessage,
  formatUnsupportedMessage,
  formatAmbiguousMessage,
  formatExpiredMessage,
  formatDeletedMessage,
  formatStoppedMessage,
  handLabel,
};
