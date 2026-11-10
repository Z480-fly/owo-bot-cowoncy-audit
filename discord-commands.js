'use strict';

const { ApplicationCommandOptionType, PermissionFlagsBits } = require('discord.js');

const OWO_COMMAND = {
  name: 'owo',
  description: 'Control or inspect the read-only OwO blackjack advisor',
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'action',
      description: 'Start, stop, check, or view statistics for the companion',
      required: false,
      choices: [
        { name: 'start', value: 'start' },
        { name: 'stop', value: 'stop' },
        { name: 'status', value: 'status' },
        { name: 'stats', value: 'stats' },
      ],
    },
  ],
};

function missingChannelPermissions(channel, user) {
  const permissions = channel?.permissionsFor?.(user);
  if (!permissions) return null;
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
  ];
  return required.filter((permission) => !permissions.has(permission));
}

async function registerCommandsForGuild(guild, logger = console) {
  try {
    await guild.commands.set([OWO_COMMAND]);
    logger.log?.(`[commands] Registered /owo in ${guild.name}`);
    return true;
  } catch (error) {
    logger.error?.(`[commands] Could not register /owo in ${guild.name}: ${error.message}`);
    return false;
  }
}

async function registerGuildCommands(client, logger = console) {
  const guilds = [...client.guilds.cache.values()];
  if (guilds.length === 0) {
    logger.warn?.('[commands] No guilds available yet; /owo will register after the bot is invited.');
    return 0;
  }

  let registered = 0;
  for (const guild of guilds) {
    if (await registerCommandsForGuild(guild, logger)) registered++;
  }
  return registered;
}

async function reply(interaction, content) {
  await interaction.reply({ content, ephemeral: true });
}

async function handleOwOCommand(interaction, { sessions, liveEnabled, logger = console }) {
  if (!interaction?.isChatInputCommand?.() || interaction.commandName !== 'owo') {
    return false;
  }

  try {
    const action = (interaction.options?.getString?.('action') || 'start').toLowerCase();
    const channelId = interaction.channelId;

    if (!interaction.inGuild?.() || !channelId) {
      await reply(interaction, 'Use `/owo` in a server text channel, not in a DM.');
      return true;
    }

    if (!interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)) {
      await reply(interaction, 'Only a server manager can use the companion controls.');
      return true;
    }

    if (action === 'status') {
      const status = sessions.getChannelStatus(channelId);
      const lines = [
        `Companion in this channel: **${status.active ? 'active' : 'inactive'}**`,
        `Live OwO tracking: **${liveEnabled ? 'enabled' : 'disabled by deployment gate'}**`,
        `Current game: **${status.hasGame ? 'tracking' : 'none'}**`,
      ];
      await reply(interaction, lines.join('\n'));
      return true;
    }

    if (action === 'stats') {
      const stats = sessions.getStats();
      const rate = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'not recorded');
      const byDealer = Object.entries(stats.byDealerUpcard)
        .map(([dealer, bucket]) => `${dealer}: ${bucket.wins}W-${bucket.losses}L-${bucket.pushes}P`)
        .join(' · ') || 'none';
      const byType = Object.entries(stats.byHandType)
        .map(([type, bucket]) => `${type}: ${bucket.wins}W-${bucket.losses}L-${bucket.pushes}P`)
        .join(' · ') || 'none';
      const lines = [
        `Hands: **${stats.hands}** · **${stats.wins}W-${stats.losses}L-${stats.pushes}P**`,
        `Win rate: **${rate(stats.winRate)}**`,
        `HIT recommendations: **${stats.hitRecommendations}** · STAND: **${stats.standRecommendations}**`,
        `Recommendation accuracy: **${rate(stats.recommendationAccuracy)}** (${stats.recommendationAccuracySamples} scored)`,
        `By dealer upcard: ${byDealer}`,
        `By hand type: ${byType}`,
        '-# Accuracy is reported only when a caller explicitly scores the recommendation; a winning hand does not automatically make the decision correct.',
      ];
      await reply(interaction, lines.join('\n'));
      return true;
    }

    if (!liveEnabled) {
      await reply(
        interaction,
        'Live OwO tracking is disabled until the embed format and Message Content Intent are verified. OwO permits third-party bots; this companion remains read-only. Set `ALLOW_LIVE_OWO=true` after those checks and restart the bot.'
      );
      return true;
    }

    if (action === 'start') {
      const missing = missingChannelPermissions(interaction.channel, interaction.client?.user);
      if (missing === null) {
        await reply(interaction, 'I could not inspect my permissions in this channel.');
        return true;
      }
      if (missing.length) {
        await reply(
          interaction,
          `I need these permissions in this channel: ${missing.join(', ')}.`
        );
        return true;
      }

      const result = sessions.activateChannel(channelId);
      await reply(
        interaction,
        result.alreadyActive
          ? 'The companion is already active in this channel. Start `owo bj <bet>` normally.'
          : 'Companion activated in this channel. Start `owo bj <bet>` normally; I will only read the OwO embed and post advice.'
      );
      return true;
    }

    if (action === 'stop') {
      const result = await sessions.deactivateChannel(channelId);
      await reply(
        interaction,
        result.wasActive || result.hadGame
          ? 'Companion stopped for this channel. The current game will no longer be tracked.'
          : 'Companion was not active in this channel.'
      );
      return true;
    }

    await reply(interaction, 'Unknown action. Use `/owo start`, `/owo stop`, `/owo status`, or `/owo stats`.');
    return true;
  } catch (error) {
    logger.error?.('[commands] /owo failed:', error.message);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await reply(interaction, 'The companion could not complete that command. Check the bot logs.');
      }
    } catch {
      // The interaction may already have expired; never let this crash the client.
    }
    return true;
  }
}

module.exports = {
  OWO_COMMAND,
  handleOwOCommand,
  registerCommandsForGuild,
  registerGuildCommands,
  missingChannelPermissions,
};
