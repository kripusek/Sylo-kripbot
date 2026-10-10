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
      String(input.title || 'Skargi i opinie')
        .trim()
        .slice(0, 256) || 'Skargi i opinie',
    message:
      String(input.message || 'Napisz opinię lub zgłoś problem administracji.')
        .trim()
        .slice(0, 2000) || 'Napisz opinię lub zgłoś problem administracji.',
    buttonLabel:
      String(input.buttonLabel || 'Napisz opinię')
        .trim()
        .slice(0, 80) || 'Napisz opinię',
    anonymousButtonLabel:
      String(input.anonymousButtonLabel || 'Napisz anonimową opinię')
        .trim()
        .slice(0, 80) || 'Napisz anonimową opinię',
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
      new EmbedBuilder().setColor(0x4aa3df).setTitle(cfg.title).setDescription(cfg.message).addFields({
        name: 'Prywatność',
        value:
          'Wybierz poniżej opinię podpisaną lub anonimową. Anonimowa opinia nie zawiera Twojego nicku ani ID w wiadomości dla administracji.',
      }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('feedback:open:identified')
          .setLabel(cfg.buttonLabel)
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('feedback:open:anonymous')
          .setLabel(cfg.anonymousButtonLabel || 'Napisz anonimową opinię')
          .setStyle(ButtonStyle.Secondary)
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

export function feedbackPicker(members, userId, requestedPage = 0, mode = 'identified') {
  const pages = Math.ceil(members.length / 25);
  const page = Math.min(Math.max(0, requestedPage), Math.max(0, pages - 1));
  if (!members.length)
    return { content: 'Nikt obecnie nie ma wybranych ról. Skontaktuj się z administracją.', components: [] };
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`feedback:person:${userId}:${mode}`)
    .setPlaceholder('Wybierz osobę, której dotyczy Twoja opinia')
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
          .setCustomId(`feedback:page:${userId}:${page - 1}:${mode}`)
          .setLabel('Poprzednia')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`feedback:page:${userId}:${page + 1}:${mode}`)
          .setLabel('Następna')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === pages - 1)
      )
    );
  return {
    content: `Wybierz osobę, której dotyczy Twoja opinia${pages > 1 ? ` (strona ${page + 1}/${pages})` : ''}:`,
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
        ? `Skarga lub ocena (${cfg.anonymous ? 'anonimowa' : 'podpisana'})`
        : cfg.anonymous
          ? 'Anonimowa opinia'
          : 'Opinia podpisana'
    )
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(targetId ? 'rating' : 'subject')
          .setLabel(targetId ? 'Ocena od 0 do 5' : 'Temat')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(targetId ? 1 : 100)
          .setPlaceholder(targetId ? 'np. 5' : 'Temat Twojej opinii')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('body')
          .setLabel('Twoja skarga lub opinia')
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
      content: 'Skargi i opinie są wyłączone na tym serwerze.',
      flags: MessageFlags.Ephemeral,
    });
  const cfg = normaliseFeedbackConfig((await getGuildModule(interaction.guildId, 'feedback')).config);
  const opened = /^feedback:open(?::(anonymous|identified))?$/.exec(interaction.customId);
  if (opened) {
    const mode = opened[1] || (cfg.anonymous ? 'anonymous' : 'identified');
    cfg.anonymous = mode === 'anonymous';
    if (!interaction.isButton() || interaction.channelId !== cfg.panelChannel)
      return interaction.reply({
        content: 'Użyj aktualnego panelu skarg i opinii.',
        flags: MessageFlags.Ephemeral,
      });
    if (!cfg.reviewChannel || cfg.reviewChannel === cfg.panelChannel)
      return interaction.reply({
        content: 'Kanał opinii dla administracji nie jest skonfigurowany.',
        flags: MessageFlags.Ephemeral,
      });
    if (cfg.subjectRoles.length) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (interaction.guild.members.cache.size < interaction.guild.memberCount)
          await interaction.guild.members.fetch();
        return interaction.editReply(
          feedbackPicker(
            feedbackCandidates(interaction.guild, cfg.subjectRoles),
            interaction.user.id,
            0,
            mode
          )
        );
      } catch {
        return interaction.editReply(
          'Nie udało się wczytać użytkowników. Administracja powinna sprawdzić, czy bot ma włączony Server Members Intent.'
        );
      }
    }
    return interaction.showModal(feedbackModal(cfg));
  }
  const person = /^feedback:person:(\d{17,20})(?::(anonymous|identified))?$/.exec(interaction.customId);
  const page = /^feedback:page:(\d{17,20}):(-?\d+)(?::(anonymous|identified))?$/.exec(interaction.customId);
  if (person || page) {
    const mode = person?.[2] || page?.[3] || (cfg.anonymous ? 'anonymous' : 'identified');
    cfg.anonymous = mode === 'anonymous';
    if ((person || page)[1] !== interaction.user.id)
      return interaction.reply({ content: 'Otwórz własny formularz opinii.', flags: MessageFlags.Ephemeral });
    if (page)
      return interaction.update(
        feedbackPicker(
          feedbackCandidates(interaction.guild, cfg.subjectRoles),
          interaction.user.id,
          Number(page[2]),
          mode
        )
      );
    if (!interaction.isStringSelectMenu()) return;
    const target = interaction.guild.members.cache.get(interaction.values[0]);
    if (!target || target.user.bot || !cfg.subjectRoles.some((role) => target.roles.cache.has(role)))
      return interaction.reply({
        content: 'Ta osoba nie jest już dostępna. Otwórz formularz ponownie.',
        flags: MessageFlags.Ephemeral,
      });
    return interaction.showModal(feedbackModal(cfg, target.id));
  }
  const submitted = /^feedback:submit:(anonymous|identified)(?::(\d{17,20}))?$/.exec(interaction.customId);
  if (!interaction.isModalSubmit() || !submitted) return;
  cfg.anonymous = submitted[1] === 'anonymous';
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!cfg.reviewChannel || cfg.reviewChannel === cfg.panelChannel)
    return interaction.editReply('Kanał opinii jest niedostępny. Skontaktuj się z administracją.');
  const targetId = submitted[2];
  if (cfg.subjectRoles.length && !targetId)
    return interaction.editReply('Otwórz formularz ponownie i wybierz osobę.');
  let target = null;
  if (targetId) {
    target = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!target || target.user.bot || !cfg.subjectRoles.some((role) => target.roles.cache.has(role)))
      return interaction.editReply('Wybrana osoba nie jest już dostępna. Otwórz formularz ponownie.');
  }
  const key = `${interaction.guildId}:${interaction.user.id}`;
  if (pending.has(key) || (cooldowns.get(key) || 0) > Date.now())
    return interaction.editReply('Poczekaj minutę przed wysłaniem kolejnego zgłoszenia.');
  const rating = target ? interaction.fields.getTextInputValue('rating').trim() : null;
  if (target && !/^[0-5]$/.test(rating))
    return interaction.editReply('Wpisz ocenę jako liczbę całkowitą od 0 do 5.');
  const subject = target
    ? 'Skarga lub ocena administracji'
    : interaction.fields.getTextInputValue('subject').trim().slice(0, 100);
  const body = interaction.fields.getTextInputValue('body').trim().slice(0, 2000);
  if (!subject || !body) return interaction.editReply('Wpisz temat i treść opinii.');
  pending.add(key);
  try {
    const embed = new EmbedBuilder().setColor(0x4aa3df).setTitle(subject).setDescription(body).setTimestamp();
    if (target)
      embed.addFields(
        { name: 'Opinia o', value: `${target.user.tag} (${target.id})` },
        { name: 'Ocena', value: `${rating}/5`, inline: true }
      );
    if (cfg.anonymous) embed.setFooter({ text: 'Anonimowe zgłoszenie' });
    else
      embed.addFields({
        name: 'Autor zgłoszenia',
        value: `${interaction.user.tag} (${interaction.user.id})`,
      });
    const delivered = await sendToChannel(interaction.guildId, cfg.reviewChannel, {
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    if (!delivered)
      return interaction.editReply(
        'Nie udało się dostarczyć zgłoszenia. Skontaktuj się z administracją lub spróbuj później.'
      );
    for (const [id, expires] of cooldowns) if (expires <= Date.now()) cooldowns.delete(id);
    cooldowns.set(key, Date.now() + COOLDOWN_MS);
    return interaction.editReply('Twoja opinia została wysłana do administracji. Dziękujemy.');
  } finally {
    pending.delete(key);
  }
}
registerComponent('feedback', 'feedback:', handleFeedback);
