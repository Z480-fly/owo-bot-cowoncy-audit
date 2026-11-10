'use strict';

const { ApplicationCommandOptionType, PermissionFlagsBits } = require('discord.js');

const OWO_COMMAND = {
  name: 'owo',
  description: 'Activate the OwO blackjack companion in this channel',
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'action',
      description: 'Start, stop, or check the companion in this channel',
      required: false,
      choices: [
        { name: 'start', value: 'start' },
        { name: 'stop', value: 'stop' },
        { name: 'status', value: 'status' },
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
      await reply(interaction, 'Only a server manager can start or stop the companion.');
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

    if (!liveEnabled) {
      await reply(
        interaction,
        'Live OwO tracking is disabled until the embed-format, Message Content Intent, and OwO permission checks are verified. Set `ALLOW_LIVE_OWO=true` after those checks and restart the bot.'
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

    await reply(interaction, 'Unknown action. Use `/owo start`, `/owo stop`, or `/owo status`.');
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
