// /override — operator-only break-glass (see modules/override.js).
import { SlashCommandBuilder, MessageFlags, InteractionContextType } from 'discord.js';
import { grantOverride, isOverrideUser } from '../../modules/override.js';

// No default member permissions on purpose: the person who needs this has lost
// theirs, and Discord would hide a permission-gated command from them.
export const data = new SlashCommandBuilder()
  .setName('override')
  .setDescription('Operator only: restore your own admin access.')
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction) {
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  if (!isOverrideUser(interaction.user.id)) return reply('Brak uprawnień.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await grantOverride(interaction.guild, interaction.user.id);
  if (!result.ok) return interaction.editReply(`❌ ${result.error}`);
  return interaction.editReply(
    `✅ Nadano rolę **${result.role.name}**${
      result.administrator
        ? ' z uprawnieniem Administratora i dostępem do panelu.'
        : ' (dostęp do panelu; bot nie ma Administratora, więc rola nie ma uprawnień Discorda).'
    }`
  );
}
