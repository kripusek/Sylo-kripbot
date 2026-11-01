// /override — operator-only break-glass (see modules/override.js).
import { SlashCommandBuilder, MessageFlags, InteractionContextType } from 'discord.js';
import { grantOverride, revokeOverride, isOverrideUser } from '../../modules/override.js';

// No default member permissions on purpose: the person who needs this has lost
// theirs, and Discord would hide a permission-gated command from them.
export const data = new SlashCommandBuilder()
  .setName('override')
  .setDescription('Operator only: restore your own admin access.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('nadaj').setDescription('Give yourself the override role.'))
  .addSubcommand((s) => s.setName('usun').setDescription('Remove the override role from yourself.'));

export async function execute(interaction) {
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  if (!isOverrideUser(interaction.user.id)) return reply('Brak uprawnień.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.options.getSubcommand() === 'usun') {
    const removed = await revokeOverride(interaction.guild, interaction.user.id);
    if (!removed.ok) return interaction.editReply(`❌ ${removed.error}`);
    return interaction.editReply(
      removed.deleted
        ? '✅ Rola usunięta (nikt inny jej nie miał, więc zniknęła też z ról panelu).'
        : '✅ Zabrano Ci rolę. Inni nadal ją mają, więc rola została.'
    );
  }
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
