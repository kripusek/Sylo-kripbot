// /level — Polish-named entry points to the leveling views: the same rank card
// as /rank and the same board as /leaderboard.
import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import * as rank from './rank.js';
import * as leaderboard from './leaderboard.js';

export const data = new SlashCommandBuilder()
  .setName('level')
  .setDescription('Leveling: your profile and the top members.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('profil')
      .setDescription('Show your leveling profile (or another member’s).')
      .addUserOption((o) => o.setName('uzytkownik').setDescription('Whose profile to show'))
  )
  .addSubcommand((s) => s.setName('top').setDescription('Show the top 10 members by XP.'));

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  return interaction.options.getSubcommand() === 'profil'
    ? rank.execute(interaction)
    : leaderboard.execute(interaction);
}
