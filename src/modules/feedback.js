import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  StringSelectMenuBuilder,
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
    subjectRoles: [...new Set([].concat(input.subjectRoles ?? []).filter((role) => snowflake(role)))],
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

export function feedbackCandidates(guild, roles) {
  return [...guild.members.cache.values()]
    .filter((member) => !member.user.bot && roles.some((role) => member.roles.cache.has(role)))
    .sort(
      (a, b) =>
        (a.displayName || a.user.username).localeCompare(b.displayName || b.user.username) ||
        a.id.localeCompare(b.id)
    );
}

export function feedbackPicker(members, userId, requestedPage = 0) {
  const pages = Math.ceil(members.length / 25);
  const page = Math.min(Math.max(0, requestedPage), Math.max(0, pages - 1));
  if (!members.length)
    return { content: 'No members currently have the selected roles. Please contact staff.', components: [] };
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`feedback:person:${userId}`)
    .setPlaceholder('Choose the person your feedback concerns')
    .addOptions(
      members.slice(page * 25, page * 25 + 25).map((member) => ({
        label: String(member.displayName || member.user.username).slice(0, 100),
        value: member.id,
        description: String(`${member.user.tag} · ${member.id}`).slice(0, 100),
      }))
    );
  const components = [new ActionRowBuilder().addComponents(menu)];
  if (pages > 1)
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`feedback:page:${userId}:${page - 1}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`feedback:page:${userId}:${page + 1}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === pages - 1)
      )
    );
  return {
    content: `Choose the person your feedback concerns${pages > 1 ? ` (page ${page + 1}/${pages})` : ''}:`,
    components,
  };
}

function feedbackModal(cfg, targetId = '') {
  return new ModalBuilder()
    .setCustomId(
      `feedback:submit:${cfg.anonymous ? 'anonymous' : 'identified'}${targetId ? `:${targetId}` : ''}`
    )
    .setTitle(
      targetId
        ? `Complaint or rating (${cfg.anonymous ? 'anonymous' : 'identified'})`
        : cfg.anonymous
          ? 'Anonymous feedback'
          : 'Feedback (staff can see your identity)'
    )
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(targetId ? 'rating' : 'subject')
          .setLabel(targetId ? 'Rating from 0 to 5' : 'Subject')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(targetId ? 1 : 100)
          .setPlaceholder(targetId ? 'e.g. 5' : 'Subject of your feedback')
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
    if (cfg.subjectRoles.length) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (interaction.guild.members.cache.size < interaction.guild.memberCount)
          await interaction.guild.members.fetch();
        return interaction.editReply(
          feedbackPicker(feedbackCandidates(interaction.guild, cfg.subjectRoles), interaction.user.id)
        );
      } catch {
        return interaction.editReply(
          'Could not load members. Staff should check that Server Members Intent is enabled for the bot.'
        );
      }
    }
    return interaction.showModal(feedbackModal(cfg));
  }
  const person = /^feedback:person:(\d{17,20})$/.exec(interaction.customId);
  const page = /^feedback:page:(\d{17,20}):(-?\d+)$/.exec(interaction.customId);
  if (person || page) {
    if ((person || page)[1] !== interaction.user.id)
      return interaction.reply({ content: 'Open your own feedback form.', flags: MessageFlags.Ephemeral });
    if (page)
      return interaction.update(
        feedbackPicker(
          feedbackCandidates(interaction.guild, cfg.subjectRoles),
          interaction.user.id,
          Number(page[2])
        )
      );
    if (!interaction.isStringSelectMenu()) return;
    const target = interaction.guild.members.cache.get(interaction.values[0]);
    if (!target || target.user.bot || !cfg.subjectRoles.some((role) => target.roles.cache.has(role)))
      return interaction.reply({
        content: 'This person is no longer available. Please open the form again.',
        flags: MessageFlags.Ephemeral,
      });
    return interaction.showModal(feedbackModal(cfg, target.id));
  }
  const submitted = /^feedback:submit:(anonymous|identified)(?::(\d{17,20}))?$/.exec(interaction.customId);
  if (!interaction.isModalSubmit() || !submitted) return;
  if ((submitted[1] === 'anonymous') !== cfg.anonymous)
    return interaction.reply({
      content: 'The privacy setting changed. Please open the form again before submitting.',
      flags: MessageFlags.Ephemeral,
    });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!cfg.reviewChannel || cfg.reviewChannel === cfg.panelChannel)
    return interaction.editReply('The staff review channel is unavailable. Please contact an administrator.');
  const targetId = submitted[2];
  if (cfg.subjectRoles.length && !targetId)
    return interaction.editReply('Please open the form again and choose a person.');
  let target = null;
  if (targetId) {
    target = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!target || target.user.bot || !cfg.subjectRoles.some((role) => target.roles.cache.has(role)))
      return interaction.editReply('The selected person is no longer available. Please open the form again.');
  }
  const key = `${interaction.guildId}:${interaction.user.id}`;
  if (pending.has(key) || (cooldowns.get(key) || 0) > Date.now())
    return interaction.editReply('Please wait one minute before sending another submission.');
  const rating = target ? interaction.fields.getTextInputValue('rating').trim() : null;
  if (target && !/^[0-5]$/.test(rating))
    return interaction.editReply('Enter a whole-number rating from 0 to 5.');
  const subject = target
    ? 'Staff complaint or rating'
    : interaction.fields.getTextInputValue('subject').trim().slice(0, 100);
  const body = interaction.fields.getTextInputValue('body').trim().slice(0, 2000);
  if (!subject || !body) return interaction.editReply('Please enter a subject and your feedback.');
  pending.add(key);
  try {
    const embed = new EmbedBuilder().setColor(0x4aa3df).setTitle(subject).setDescription(body).setTimestamp();
    if (target)
      embed.addFields(
        { name: 'Feedback about', value: `${target.user.tag} (${target.id})` },
        { name: 'Rating', value: `${rating}/5`, inline: true }
      );
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
