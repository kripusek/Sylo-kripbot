// User menu: right-click a member → Apps → Ostrzeż. Opens a reason form, then issues
// the same warning as /warn add. Access follows the /warn delegation rules.
import {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  InteractionContextType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
} from 'discord.js';
import { registerComponent } from '../lib/components.js';
import { overrideBlockReason } from '../events/interactionCreate.js';
import { issueWarning } from './warn.js';

const PREFIX = 'ctxwarn:';

export const data = new ContextMenuCommandBuilder()
  .setName('Ostrzeż')
  .setType(ApplicationCommandType.User)
  .setContexts(InteractionContextType.Guild);

/** @param {import('discord.js').UserContextMenuCommandInteraction} interaction */
export async function execute(interaction) {
  if (interaction.targetUser.bot)
    return interaction.reply({ content: '⚠️ Nie możesz ostrzec bota.', flags: MessageFlags.Ephemeral });
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}${interaction.targetUser.id}`)
    .setTitle(`Ostrzeżenie: ${interaction.targetUser.username}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Powód')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(400)
      )
    );
  return interaction.showModal(modal);
}

registerComponent('ctx-warn', PREFIX, async (interaction) => {
  // The form can be submitted later than the menu was opened: check access again.
  const blocked = await overrideBlockReason({
    commandName: 'Ostrzeż',
    inGuild: () => interaction.inGuild(),
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    member: interaction.member,
    memberPermissions: interaction.memberPermissions,
  });
  if (blocked) return interaction.reply({ content: `⚠️ ${blocked}`, flags: MessageFlags.Ephemeral });
  const targetId = interaction.customId.slice(PREFIX.length);
  const user = await interaction.client.users.fetch(targetId).catch(() => null);
  if (!user || user.bot)
    return interaction.reply({
      content: '⚠️ Nie znaleziono tego użytkownika.',
      flags: MessageFlags.Ephemeral,
    });
  return issueWarning(
    interaction,
    user,
    interaction.fields.getTextInputValue('reason').trim() || 'Nie podano powodu.'
  );
});
