// /info kara <konto> — every punishment an account has ever had on this server.
import { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType } from 'discord.js';
import { showHistory } from './history.js';

export const data = new SlashCommandBuilder()
  .setName('info')
  .setDescription('Look up information about an account.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand((s) =>
    s
      .setName('kara')
      .setDescription('Show every punishment this account has had (warns, timeouts, kicks, bans).')
      .addUserOption((o) => o.setName('konto').setDescription('The account to look up').setRequired(true))
      .addIntegerOption((o) => o.setName('strona').setDescription('Page number').setMinValue(1))
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  return showHistory(
    interaction,
    interaction.options.getUser('konto', true),
    interaction.options.getInteger('strona') ?? 1,
    'info'
  );
}
