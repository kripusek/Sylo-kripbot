// User menu (right-click a member → Apps): Wycisz / odcisz, Wyrzuć, Zbanuj.
// Each runs the same code as its slash command (/timeout or /untimeout, /kick, /ban)
// and follows that command's delegation rules (see commandAccess.js).
// Helper module (not a command): the per-command ctx-*.js files import it.
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
import { registerComponent } from './components.js';
import { overrideBlockReason } from '../events/interactionCreate.js';
import { NO_REASON } from './moderation.js';

export const userMenu = (name) =>
  new ContextMenuCommandBuilder()
    .setName(name)
    .setType(ApplicationCommandType.User)
    .setContexts(InteractionContextType.Guild);

const input = (id, label, { required = false, max = 400, long = false, placeholder } = {}) =>
  new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(required)
      .setMaxLength(max)
      .setPlaceholder(placeholder ?? '')
  );

export const reasonInput = () => input('reason', 'Powód', { long: true });
export const durationInput = (required, label = 'Czas (np. 30m, 2h, 1d)') =>
  input('duration', label, { required, max: 20 });

/**
 * Register a menu command that asks a short form, then runs `run`.
 * `prefix` is the modal id prefix, `commandName` the menu command's name (its
 * access rules are re-checked when the form is submitted).
 */
export function modalMenu({ commandName, prefix, title, fields, run, allowBots = false }) {
  async function execute(interaction) {
    if (!allowBots && interaction.targetUser.bot)
      return interaction.reply({
        content: '⚠️ Nie możesz tego zrobić na bocie.',
        flags: MessageFlags.Ephemeral,
      });
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId(`${prefix}${interaction.targetUser.id}`)
        .setTitle(`${title}: ${interaction.targetUser.username}`.slice(0, 45))
        .addComponents(...fields)
    );
  }
  registerComponent(`ctx-${prefix}`, prefix, async (interaction) => {
    const blocked = await overrideBlockReason({
      commandName,
      inGuild: () => interaction.inGuild(),
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      member: interaction.member,
      memberPermissions: interaction.memberPermissions,
    });
    if (blocked) return interaction.reply({ content: `⚠️ ${blocked}`, flags: MessageFlags.Ephemeral });
    const targetId = interaction.customId.slice(prefix.length);
    const user = await interaction.client.users.fetch(targetId).catch(() => null);
    if (!user)
      return interaction.reply({
        content: '⚠️ Nie znaleziono tego użytkownika.',
        flags: MessageFlags.Ephemeral,
      });
    const member = await interaction.guild.members.fetch(targetId).catch(() => null);
    const text = (id) => interaction.fields.getTextInputValue(id)?.trim() ?? '';
    return run(interaction, { user, member, reason: text('reason') || NO_REASON, text });
  });
  return execute;
}
