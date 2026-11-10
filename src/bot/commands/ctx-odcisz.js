// User menu: right-click a member → Apps → Odcisz (same as /untimeout; no form needed).
import { MessageFlags } from 'discord.js';
import { userMenu } from '../lib/contextMenus.js';
import { NO_REASON } from '../lib/moderation.js';
import { applyUntimeout } from './untimeout.js';

export const data = userMenu('Odcisz');
export async function execute(interaction) {
  if (interaction.targetUser.bot)
    return interaction.reply({
      content: '⚠️ Nie możesz tego zrobić na bocie.',
      flags: MessageFlags.Ephemeral,
    });
  const member = await interaction.guild.members.fetch(interaction.targetUser.id).catch(() => null);
  return applyUntimeout(interaction, member, NO_REASON);
}
