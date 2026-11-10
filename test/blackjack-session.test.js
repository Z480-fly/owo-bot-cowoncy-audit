'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BlackjackSessionManager } = require('../blackjack-session');
const { makeOwOMessage, endedMessage } = require('./fixtures');

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

function makeManager(sink, overrides = {}) {
  return new BlackjackSessionManager({
    sink,
    trackedChannelIds: ['channel-1'],
    owoBotId: '408785106942164992',
    idleMs: 10_000,
    now: () => 1_000,
    ...overrides,
  });
}

test('starts one advice message and edits it on a later OwO edit', async () => {
  const sink = new FakeSink();
  const manager = makeManager(sink);

  const started = await manager.handleMessage(makeOwOMessage());
  assert.equal(started.status, 'started');
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.calls[0].messageId, null);
  assert.match(sink.calls[0].content, /^# HIT/m);

  const updated = await manager.handleMessage(
    makeOwOMessage({
      player: ['10s', '6h', '2c'],
      editedTimestamp: 2_000,
    })
  );
  assert.equal(updated.status, 'updated');
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.calls[1].messageId, 'advice-1');
  assert.equal(sink.calls[1].id, 'advice-1');
  assert.match(sink.calls[1].content, /Hard 18/);
});

test('deduplicates repeated create/update events', async () => {
  const sink = new FakeSink();
  const manager = makeManager(sink);
  const message = makeOwOMessage();

  await manager.handleMessage(message);
  const duplicate = await manager.handleMessage(message);

  assert.equal(duplicate.status, 'duplicate');
  assert.equal(sink.calls.length, 1);
});

test('accepts a missed edit because each update carries the full hand', async () => {
  const sink = new FakeSink();
  const manager = makeManager(sink);

  await manager.handleMessage(makeOwOMessage());
  const jumped = await manager.handleMessage(
    makeOwOMessage({
      player: ['10s', '6h', '2c', '3d'],
      editedTimestamp: 3_000,
    })
  );

  assert.equal(jumped.status, 'updated');
  assert.match(sink.calls.at(-1).content, /Hard 21/);
});

test('ignores an older edit than the current state', async () => {
  const sink = new FakeSink();
  const manager = makeManager(sink);

  await manager.handleMessage(makeOwOMessage({ editedTimestamp: 5_000 }));
  const stale = await manager.handleMessage(
    makeOwOMessage({
      player: ['10s', '6h', '2c'],
      editedTimestamp: 4_000,
    })
  );

  assert.equal(stale.status, 'stale');
  assert.equal(sink.calls.length, 1);
});

test('handles an ended game and allows a new game in the same channel', async () => {
  const sink = new FakeSink();
  const manager = makeManager(sink);

  await manager.handleMessage(makeOwOMessage());
  const ended = await manager.handleMessage(
    endedMessage({ editedTimestamp: 2_000 })
  );
  assert.equal(ended.status, 'ended');
  assert.match(sink.calls.at(-1).content, /^# HAND COMPLETE/m);

  const next = await manager.handleMessage(
    makeOwOMessage({
      id: 'message-2',
      createdTimestamp: 3_000,
    })
  );
  assert.equal(next.status, 'started');
  assert.equal(sink.calls.length, 3);
  assert.equal(sink.calls.at(-1).messageId, null);
});

test('pauses instead of guessing when another active game appears', async () => {
  const sink = new FakeSink();
  const manager = makeManager(sink);

  await manager.handleMessage(makeOwOMessage());
  const ambiguous = await manager.handleMessage(
    makeOwOMessage({
      id: 'message-2',
      createdTimestamp: 2_000,
    })
  );

  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.reports.length, 1);
  assert.match(sink.reports[0].content, /one active game per channel/);

  const stillTrackingOriginal = await manager.handleMessage(
    makeOwOMessage({
      player: ['10s', '6h', '2c'],
      editedTimestamp: 3_000,
    })
  );
  assert.equal(stillTrackingOriginal.status, 'updated');
});

test('reports an unsupported initial format and creates no advice', async () => {
  const sink = new FakeSink();
  const manager = makeManager(sink);

  const result = await manager.handleMessage(
    makeOwOMessage({
      player: ['7h', '7s'],
      dealer: ['9c'],
    })
  );

  assert.equal(result.status, 'unsupported');
  assert.equal(sink.calls.length, 0);
  assert.equal(sink.reports.length, 1);
  assert.match(sink.reports[0].content, /7♥/);
});

test('pauses an active game if its later edit becomes unsupported', async () => {
  const sink = new FakeSink();
  const manager = makeManager(sink);

  await manager.handleMessage(makeOwOMessage());
  const result = await manager.handleMessage(
    makeOwOMessage({
      player: ['10s', '6h'],
      dealer: ['9c', '5d'],
      editedTimestamp: 2_000,
    })
  );

  assert.equal(result.status, 'unsupported');
  assert.match(sink.calls.at(-1).content, /^# ADVICE PAUSED/m);
});

test('stops tracking if the OwO game message is deleted', async () => {
  const sink = new FakeSink();
  const manager = makeManager(sink);

  await manager.handleMessage(makeOwOMessage());
  const deleted = await manager.handleDelete('channel-1', 'message-1');

  assert.equal(deleted.status, 'deleted');
  assert.match(sink.calls.at(-1).content, /^# TRACKING STOPPED/m);
});

test('activates and deactivates a channel at runtime', async () => {
  const sink = new FakeSink();
  const manager = makeManager(sink, { trackedChannelIds: [] });

  const ignored = await manager.handleMessage(makeOwOMessage());
  assert.equal(ignored.status, 'ignored');
  assert.equal(manager.getChannelStatus('channel-1').active, false);

  manager.activateChannel('channel-1');
  assert.equal(manager.getChannelStatus('channel-1').active, true);
  const started = await manager.handleMessage(makeOwOMessage());
  assert.equal(started.status, 'started');

  const stopped = await manager.deactivateChannel('channel-1');
  assert.equal(stopped.hadGame, true);
  assert.equal(manager.getChannelStatus('channel-1').active, false);
  assert.equal(manager.getChannelStatus('channel-1').hasGame, false);
  assert.match(sink.calls.at(-1).content, /stopped with `\/owo stop`/);

  const afterStop = await manager.handleMessage(
    makeOwOMessage({ editedTimestamp: 2_000 })
  );
  assert.equal(afterStop.status, 'ignored');
});

test('expires an idle session and stops editing it', async () => {
  let clock = 1_000;
  const sink = new FakeSink();
  const manager = makeManager(sink, { now: () => clock, idleMs: 1_000 });

  await manager.handleMessage(makeOwOMessage());
  clock += 1_001;
  await manager.expireStale();

  assert.match(sink.calls.at(-1).content, /^# TRACKING STOPPED/m);
  const ignored = await manager.handleMessage(
    makeOwOMessage({
      player: ['10s', '6h', '2c'],
      editedTimestamp: 3_000,
    })
  );
  assert.equal(ignored.status, 'started');
});
