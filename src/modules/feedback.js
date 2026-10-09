import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { registerComponent } from '../bot/lib/components.js';
import { getGuildModule, isModuleEnabled } from '../db/modules.js';
import { sendToChannel } from './lib/send.js';

const snowflake = (value) => (/^\d{17,20}$/.test(value ?? '') ? value : '');
export function normaliseFeedbackConfig(input = {}, previous = {}) {
  const panelChannel = snowflake(input.panelChannel);
  return {
    panelChannel,
    panelMessageId: panelChannel === previous.panelChannel ? previous.panelMessageId || '' : '',
    reviewChannel: snowflake(input.reviewChannel),
    title:
      String(input.title || 'Complaints and feedback')
        .trim()
        .slice(0, 256) || 'Complaints and feedback',
    message:
      String(input.message || 'Share feedback or report an issue to the administration.')
        .trim()
        .slice(0, 2000) || 'Share feedback or report an issue to the administration.',
    buttonLabel:
      String(input.buttonLabel || 'Write feedback')
        .trim()
        .slice(0, 80) || 'Write feedback',
    anonymous: input.anonymous === true || input.anonymous === 'on',
  };
}

export async function publishFeedbackPanel(guild, cfg) {
  if (!cfg.panelChannel || !cfg.reviewChannel) throw new Error('Choose both the panel and review channels.');
  if (cfg.panelChannel === cfg.reviewChannel) throw new Error('Choose a separate private review channel.');
  const channel = await guild.channels.fetch(cfg.panelChannel);
  const review = await guild.channels.fetch(cfg.reviewChannel);
  if (!channel?.isTextBased() || !review?.isTextBased())
    throw new Error('A configured channel is unavailable.');
  for (const target of [channel, review]) {
    if (!target.permissionsFor(guild.members.me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks']))
      throw new Error('The bot needs View Channel, Send Messages and Embed Links in both channels.');
  }
  const payload = {
    embeds: [
      new EmbedBuilder()
        .setColor(0x4aa3df)
        .setTitle(cfg.title)
        .setDescription(cfg.message)
        .addFields({
          name: 'Privacy',
          value: cfg.anonymous
            ? 'Your identity will not be included in the submission sent to staff.'
            : 'Staff will see your Discord username and user ID. Submissions are sent to the configured review channel.',
        }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('feedback:open')
          .setLabel(cfg.buttonLabel)
          .setStyle(ButtonStyle.Primary)
      ),
    ],
    allowedMentions: { parse: [] },
  };
  const existing = cfg.panelMessageId
    ? await channel.messages.fetch(cfg.panelMessageId).catch(() => null)
    : null;
  if (existing?.author.id === guild.members.me.id) return (await existing.edit(payload)).id;
  return (await channel.send(payload)).id;
}

// Only cooldown timestamps are kept in memory; submission text is sent to Discord.
const cooldowns = new Map();
const pending = new Set();
const COOLDOWN_MS = 60000;
export async function handleFeedback(interaction) {
  if (!interaction.guildId || !(await isModuleEnabled(interaction.guildId, 'feedback')))
    return interaction.reply({
      content: 'Feedback is disabled in this server.',
      flags: MessageFlags.Ephemeral,
    });
  const cfg = normaliseFeedbackConfig((await getGuildModule(interaction.guildId, 'feedback')).config);
  if (interaction.customId === 'feedback:open') {
    if (!interaction.isButton() || interaction.channelId !== cfg.panelChannel)
      return interaction.reply({
        content: 'Please use the current feedback panel.',
        flags: MessageFlags.Ephemeral,
      });
    if (!cfg.reviewChannel || cfg.reviewChannel === cfg.panelChannel)
      return interaction.reply({
        content: 'The staff review channel is not configured.',
        flags: MessageFlags.Ephemeral,
      });
    const modal = new ModalBuilder()
      .setCustomId(`feedback:submit:${cfg.anonymous ? 'anonymous' : 'identified'}`)
      .setTitle(cfg.anonymous ? 'Anonymous feedback' : 'Feedback (staff can see your identity)')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('subject')
            .setLabel('Subject')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('body')
            .setLabel('Your complaint or feedback')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(2000)
        )
      );
    return interaction.showModal(modal);
  }
  if (
    !interaction.isModalSubmit() ||
    !['feedback:submit:anonymous', 'feedback:submit:identified'].includes(interaction.customId)
  )
    return;
  if (interaction.customId.endsWith(':anonymous') !== cfg.anonymous)
    return interaction.reply({
      content: 'The privacy setting changed. Please open the form again before submitting.',
      flags: MessageFlags.Ephemeral,
    });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!cfg.reviewChannel || cfg.reviewChannel === cfg.panelChannel)
    return interaction.editReply('The staff review channel is unavailable. Please contact an administrator.');
  const key = `${interaction.guildId}:${interaction.user.id}`;
  if (pending.has(key) || (cooldowns.get(key) || 0) > Date.now())
    return interaction.editReply('Please wait one minute before sending another submission.');
  const subject = interaction.fields.getTextInputValue('subject').trim().slice(0, 100);
  const body = interaction.fields.getTextInputValue('body').trim().slice(0, 2000);
  if (!subject || !body) return interaction.editReply('Please enter a subject and your feedback.');
  pending.add(key);
  try {
    const embed = new EmbedBuilder().setColor(0x4aa3df).setTitle(subject).setDescription(body).setTimestamp();
    if (cfg.anonymous) embed.setFooter({ text: 'Anonymous submission' });
    else embed.addFields({ name: 'Submitted by', value: `${interaction.user.tag} (${interaction.user.id})` });
    const delivered = await sendToChannel(interaction.guildId, cfg.reviewChannel, {
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    if (!delivered)
      return interaction.editReply(
        'Could not deliver your submission. Please contact staff or try again later.'
      );
    for (const [id, expires] of cooldowns) if (expires <= Date.now()) cooldowns.delete(id);
    cooldowns.set(key, Date.now() + COOLDOWN_MS);
    return interaction.editReply('Your feedback was sent to staff. Thank you.');
  } finally {
    pending.delete(key);
  }
}
registerComponent('feedback', 'feedback:', handleFeedback);
