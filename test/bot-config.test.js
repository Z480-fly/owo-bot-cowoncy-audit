'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../bot');

test('requires a token but allows setup mode without a live gate', () => {
  assert.throws(() => loadConfig({}), /DISCORD_TOKEN/);

  const config = loadConfig({ DISCORD_TOKEN: 'test-token' });
  assert.equal(config.liveEnabled, false);
  assert.deepEqual(config.trackedChannelIds, []);
});

test('enables live tracking only for the exact true value', () => {
  assert.equal(
    loadConfig({ DISCORD_TOKEN: 'test-token', ALLOW_LIVE_OWO: 'TRUE' }).liveEnabled,
    false
  );
  assert.equal(
    loadConfig({ DISCORD_TOKEN: 'test-token', ALLOW_LIVE_OWO: 'true' }).liveEnabled,
    true
  );
});

test('parses preconfigured channels but permits slash-command activation', () => {
  const config = loadConfig({
    DISCORD_TOKEN: 'test-token',
    TRACK_CHANNEL_IDS: ' channel-a, channel-b ,',
  });

  assert.deepEqual(config.trackedChannelIds, ['channel-a', 'channel-b']);
  assert.equal(config.liveEnabled, false);
});
