// User menu: right-click a member → Apps → Kary. Same data and access rules as /history.
import { ContextMenuCommandBuilder, ApplicationCommandType, InteractionContextType } from 'discord.js';
import { showHistory } from './history.js';

export const data = new ContextMenuCommandBuilder()
  .setName('Kary')
  .setType(ApplicationCommandType.User)
  .setContexts(InteractionContextType.Guild);

/** @param {import('discord.js').UserContextMenuCommandInteraction} interaction */
export async function execute(interaction) {
  return showHistory(interaction, interaction.targetUser, 1, 'history');
}
