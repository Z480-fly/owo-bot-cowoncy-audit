'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OWO_COMMAND,
  handleOwOCommand,
  registerGuildCommands,
} = require('../discord-commands');
const { BlackjackSessionManager } = require('../blackjack-session');

class FakeSink {
  constructor() {
    this.calls = [];
  }

  async upsert(channelId, messageId, content) {
    this.calls.push({ channelId, messageId, content });
    return messageId || 'advice-1';
  }

  async report() {}
}

function makeSessions() {
  return new BlackjackSessionManager({
    sink: new FakeSink(),
    trackedChannelIds: [],
    now: () => 1_000,
  });
}

function makeInteraction({
  action = null,
  permitted = true,
  channelId = 'channel-1',
  inGuild = true,
} = {}) {
  const replies = [];
  const interaction = {
    commandName: 'owo',
    channelId,
    channel: {
      permissionsFor: () => ({ has: () => true }),
    },
    client: { user: { id: 'companion' } },
    memberPermissions: { has: () => permitted },
    isChatInputCommand: () => true,
    inGuild: () => inGuild,
    options: { getString: () => action },
    replied: false,
    deferred: false,
    async reply(payload) {
      this.replied = true;
      replies.push(payload);
    },
  };
  return { interaction, replies };
}

test('registers a single /owo command with control and stats choices', () => {
  assert.equal(OWO_COMMAND.name, 'owo');
  assert.equal(OWO_COMMAND.options[0].name, 'action');
  assert.deepEqual(
    OWO_COMMAND.options[0].choices.map((choice) => choice.value),
    ['start', 'stop', 'status', 'stats']
  );
});

test('registers /owo automatically in every joined guild', async () => {
  const registered = [];
  const client = {
    guilds: {
      cache: new Map([
        [
          'guild-1',
          {
            name: 'Test Guild',
            commands: {
              async set(commands) {
                registered.push(commands);
              },
            },
          },
        ],
      ]),
    },
  };

  const count = await registerGuildCommands(client, {
    log() {},
    warn() {},
    error() {},
  });

  assert.equal(count, 1);
  assert.equal(registered[0][0].name, 'owo');
});

test('defaults bare /owo to start when live tracking is enabled', async () => {
  const sessions = makeSessions();
  const { interaction, replies } = makeInteraction();

  const handled = await handleOwOCommand(interaction, {
    sessions,
    liveEnabled: true,
    logger: { error() {} },
  });

  assert.equal(handled, true);
  assert.equal(sessions.getChannelStatus('channel-1').active, true);
  assert.match(replies[0].content, /Companion activated/);
});

test('refuses activation while the live gate is closed', async () => {
  const sessions = makeSessions();
  const { interaction, replies } = makeInteraction();

  await handleOwOCommand(interaction, {
    sessions,
    liveEnabled: false,
    logger: { error() {} },
  });

  assert.equal(sessions.getChannelStatus('channel-1').active, false);
  assert.match(replies[0].content, /disabled/);
});

test('requires a server manager', async () => {
  const sessions = makeSessions();
  const { interaction, replies } = makeInteraction({ permitted: false });

  await handleOwOCommand(interaction, {
    sessions,
    liveEnabled: true,
    logger: { error() {} },
  });

  assert.equal(sessions.getChannelStatus('channel-1').active, false);
  assert.match(replies[0].content, /server manager/);
});

test('fails closed if channel permissions cannot be inspected', async () => {
  const sessions = makeSessions();
  const { interaction, replies } = makeInteraction();
  interaction.channel.permissionsFor = () => null;

  await handleOwOCommand(interaction, {
    sessions,
    liveEnabled: true,
    logger: { error() {} },
  });

  assert.equal(sessions.getChannelStatus('channel-1').active, false);
  assert.match(replies[0].content, /could not inspect/);
});

test('stops an activated channel before a hand starts', async () => {
  const sessions = makeSessions();
  sessions.activateChannel('channel-1');
  const { interaction, replies } = makeInteraction({ action: 'stop' });

  await handleOwOCommand(interaction, {
    sessions,
    liveEnabled: true,
    logger: { error() {} },
  });

  assert.equal(sessions.getChannelStatus('channel-1').active, false);
  assert.match(replies[0].content, /Companion stopped/);
});

test('stops an activated channel and reports status', async () => {
  const sessions = makeSessions();
  sessions.activateChannel('channel-1');

  const stop = makeInteraction({ action: 'stop' });
  await handleOwOCommand(stop.interaction, {
    sessions,
    liveEnabled: true,
    logger: { error() {} },
  });
  assert.equal(sessions.getChannelStatus('channel-1').active, false);
  assert.match(stop.replies[0].content, /not active|no longer be tracked/);

  const status = makeInteraction({ action: 'status' });
  await handleOwOCommand(status.interaction, {
    sessions,
    liveEnabled: true,
    logger: { error() {} },
  });
  assert.match(status.replies[0].content, /inactive/);
});

test('reports separate win rate and recommendation accuracy', async () => {
  const sessions = makeSessions();
  sessions.stats.record({
    outcome: 'win',
    recommendation: 'HIT',
    dealer: '8',
    handType: 'hard',
    recommendationCorrect: null,
  });
  const stats = makeInteraction({ action: 'stats' });
  await handleOwOCommand(stats.interaction, {
    sessions,
    liveEnabled: false,
    logger: { error() {} },
  });
  const content = stats.replies[0].content;
  assert.match(content, /Hands: \*\*1\*\*/);
  assert.match(content, /Win rate: \*\*100\.0%\*\*/);
  assert.match(content, /Recommendation accuracy: \*\*not recorded\*\*/);
  assert.match(content, /By dealer upcard: 8: 1W-0L-0P/);
});

test('ignores unrelated interactions', async () => {
  const sessions = makeSessions();
  const { interaction } = makeInteraction();
  interaction.commandName = 'other';

  const handled = await handleOwOCommand(interaction, {
    sessions,
    liveEnabled: true,
  });
  assert.equal(handled, false);
});
