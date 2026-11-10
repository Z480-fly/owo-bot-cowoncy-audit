'use strict';

const {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  Partials,
} = require('discord.js');
const { BlackjackSessionManager } = require('./blackjack-session');
const { DEFAULT_OWO_BOT_ID } = require('./owo-blackjack-parser');
const {
  handleOwOCommand,
  registerCommandsForGuild,
  registerGuildCommands,
} = require('./discord-commands');

const REQUIRED_SOURCE_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
];
const REQUIRED_ADVICE_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
];

function parseIdList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIdleMs(value, fallback = 90_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadConfig(env = process.env) {
  const token = String(env.DISCORD_TOKEN || '').trim();
  if (!token) throw new Error('DISCORD_TOKEN is missing');

  const trackedChannelIds = parseIdList(env.TRACK_CHANNEL_IDS);
  const liveEnabled = env.ALLOW_LIVE_OWO === 'true';

  return {
    token,
    owoBotId: String(env.OWO_BOT_ID || DEFAULT_OWO_BOT_ID).trim(),
    trackedChannelIds,
    adviceChannelId: String(env.ADVICE_CHANNEL_ID || '').trim() || null,
    idleMs: parseIdleMs(env.SESSION_IDLE_MS),
    liveEnabled,
  };
}

class DiscordAdviceSink {
  constructor(client, adviceChannelId = null, logger = console) {
    this.client = client;
    this.adviceChannelId = adviceChannelId;
    this.logger = logger;
  }

  _outputChannelId(sourceChannelId) {
    return this.adviceChannelId || sourceChannelId;
  }

  async _channel(sourceChannelId) {
    const channelId = this._outputChannelId(sourceChannelId);
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased?.()) {
      throw new Error(`Output channel ${channelId} is not a guild text channel`);
    }
    return channel;
  }

  async upsert(sourceChannelId, existingMessageId, content) {
    const channel = await this._channel(sourceChannelId);

    if (existingMessageId) {
      try {
        const existing = await channel.messages.fetch(existingMessageId);
        await existing.edit({ content, allowedMentions: { parse: [] } });
        return existing.id;
      } catch (error) {
        // Unknown Message (10008) or a deleted message: recreate once.
        if (error?.code !== 10008 && error?.status !== 404) throw error;
      }
    }

    const sent = await channel.send({ content, allowedMentions: { parse: [] } });
    return sent.id;
  }

  async report(sourceChannelId, content) {
    const channel = await this._channel(sourceChannelId);
    await channel.send({ content, allowedMentions: { parse: [] } });
  }
}

async function checkChannelPermissions(client, channelId, required, label) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) throw new Error(`${label} channel ${channelId} is not accessible`);
  if (!channel.isTextBased() || channel.isDMBased?.()) {
    throw new Error(`${label} channel ${channelId} is not a guild text channel`);
  }

  const permissions = channel.permissionsFor(client.user);
  if (!permissions) throw new Error(`Could not inspect permissions for ${label} channel ${channelId}`);
  const missing = required.filter((permission) => !permissions.has(permission));
  if (missing.length > 0) {
    throw new Error(
      `${label} channel ${channelId} is missing required permissions: ${missing.join(', ')}`
    );
  }
  return channel;
}

async function start() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`[startup] ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    // Allows the bot to fetch an OwO message that was already active before
    // its first update reached the gateway.
    partials: [Partials.Message],
  });

  const sink = new DiscordAdviceSink(client, config.adviceChannelId);
  const sessions = new BlackjackSessionManager({
    sink,
    trackedChannelIds: config.trackedChannelIds,
    owoBotId: config.owoBotId,
    idleMs: config.idleMs,
    logger: console,
  });

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      if (!readyClient.options.intents.has(GatewayIntentBits.MessageContent)) {
        throw new Error('Message Content Intent is not requested by the client');
      }

      for (const channelId of config.trackedChannelIds) {
        await checkChannelPermissions(
          readyClient,
          channelId,
          REQUIRED_SOURCE_PERMISSIONS,
          'Source'
        );
      }
      if (config.adviceChannelId && !config.trackedChannelIds.includes(config.adviceChannelId)) {
        await checkChannelPermissions(
          readyClient,
          config.adviceChannelId,
          REQUIRED_ADVICE_PERMISSIONS,
          'Advice'
        );
      }

      await registerGuildCommands(readyClient, console);

      const inviteUrl =
        `https://discord.com/oauth2/authorize?client_id=${readyClient.user.id}` +
        '&permissions=68608&scope=bot%20applications.commands';
      console.log(`[ready] Logged in as ${readyClient.user.tag}`);
      console.log(`[ready] Invite URL: ${inviteUrl}`);
      if (config.liveEnabled) {
        console.log(`[ready] Live tracking enabled for ${config.trackedChannelIds.length} preconfigured channel(s).`);
        console.log('[ready] Use /owo in a channel to activate it on demand.');
      } else {
        console.log('[ready] Setup mode: live OwO tracking is disabled by ALLOW_LIVE_OWO.');
        console.log('[ready] /owo is registered, but it will refuse to activate until the gate is opened.');
      }
      console.log('[ready] Read-only advisor; no OwO commands, reactions, or bets are sent.');
    } catch (error) {
      console.error(`[startup] ${error.message}`);
      await client.destroy();
      process.exitCode = 1;
    }
  });

  client.on(Events.Error, (error) => {
    console.error('[discord]', error.message);
  });

  client.on(Events.ShardError, (error, shardId) => {
    console.error(`[shard ${shardId}]`, error.message);
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(`[shard ${shardId}] disconnected (${event.code}); discord.js will reconnect.`);
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    console.log(`[shard ${shardId}] reconnecting`);
  });

  client.on(Events.GuildCreate, (guild) => {
    void registerCommandsForGuild(guild, console).catch((error) => {
      console.error('[commands] Guild registration failed:', error.message);
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleOwOCommand(interaction, {
      sessions,
      liveEnabled: config.liveEnabled,
      logger: console,
    }).catch((error) => {
      console.error('[interaction]', error.message);
    });
  });

  client.on(Events.MessageCreate, (message) => {
    if (!config.liveEnabled) return;
    if (message.author?.id !== config.owoBotId) return;
    void sessions.handleMessage(message).catch((error) => {
      console.error('[messageCreate]', error.message);
    });
  });

  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    if (!config.liveEnabled) return;
    let fullMessage = newMessage;
    try {
      if (fullMessage.partial) fullMessage = await fullMessage.fetch();
      if (fullMessage.author?.id !== config.owoBotId) return;
      if (!fullMessage.embeds || fullMessage.embeds.length === 0) {
        fullMessage = await fullMessage.fetch();
      }
      await sessions.handleMessage(fullMessage);
    } catch (error) {
      console.error('[messageUpdate]', error.message);
    }
  });

  client.on(Events.MessageDelete, (message) => {
    if (!config.liveEnabled) return;
    if (!message.channelId) return;
    void sessions.handleDelete(message.channelId, message.id).catch((error) => {
      console.error('[messageDelete]', error.message);
    });
  });

  const sweepTimer = setInterval(() => {
    void sessions.expireStale().catch((error) => {
      console.error('[session sweep]', error.message);
    });
  }, Math.min(15_000, config.idleMs));
  sweepTimer.unref();

  const shutdown = async () => {
    clearInterval(sweepTimer);
    await client.destroy();
  };
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));

  try {
    await client.login(config.token);
  } catch (error) {
    console.error(`[login] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void start();
}

module.exports = {
  loadConfig,
  parseIdList,
  parseIdleMs,
  DiscordAdviceSink,
  checkChannelPermissions,
  REQUIRED_SOURCE_PERMISSIONS,
  REQUIRED_ADVICE_PERMISSIONS,
};
