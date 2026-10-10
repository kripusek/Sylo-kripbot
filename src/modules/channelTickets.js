import { randomUUID } from 'node:crypto';
import {
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { registerComponent } from '../bot/lib/components.js';
import { getGuildModule, isModuleEnabled } from '../db/modules.js';
import { sendToChannel } from './lib/send.js';

const id = (value) => (/^\d{17,20}$/.test(value ?? '') ? value : '');
export function normaliseChannelTickets(input = {}, previous = {}) {
  const seen = new Set();
  const types = (Array.isArray(input.ticketTypes) ? input.ticketTypes : []).slice(0, 25).flatMap((row) => {
    const label = String(row.label ?? '')
      .trim()
      .slice(0, 100);
    if (!label) return [];
    let key = /^[a-zA-Z0-9_-]{1,50}$/.test(row.id ?? '') ? row.id : randomUUID();
    if (seen.has(key)) key = randomUUID();
    seen.add(key);
    return [
      {
        id: key,
        label,
        description: String(row.description ?? '')
          .trim()
          .slice(0, 100),
        categoryId: id(row.categoryId),
      },
    ];
  });
  const panelChannel = id(input.panelChannel);
  return {
    panelChannel,
    panelMessageId: panelChannel === previous.panelChannel ? previous.panelMessageId || '' : '',
    panelTitle: String(input.panelTitle || 'Support tickets').slice(0, 256),
    panelText: String(input.panelText || 'Choose a topic below to open a private ticket.').slice(0, 2000),
    ticketLogChannel: id(input.ticketLogChannel),
    ticketTypes: types,
    pingRoles: [...new Set([].concat(input.pingRoles ?? []).filter((role) => id(role)))].slice(0, 20),
  };
}

export async function publishTicketPanel(guild, cfg) {
  if (!cfg.panelChannel || !cfg.ticketTypes?.length)
    throw new Error('Choose a panel channel and add at least one ticket type.');
  if (cfg.ticketTypes.some((type) => !type.categoryId))
    throw new Error('Choose a category for every ticket type.');
  for (const type of cfg.ticketTypes) {
    const category = await guild.channels.fetch(type.categoryId);
    if (category?.type !== ChannelType.GuildCategory)
      throw new Error('A ticket category is missing. Choose it again.');
  }
  const channel = await guild.channels.fetch(cfg.panelChannel);
  if (!channel?.isTextBased()) throw new Error('The panel channel is unavailable.');
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket-channel:open')
    .setPlaceholder('Wybierz temat zgłoszenia')
    .addOptions(
      cfg.ticketTypes.map((type) => ({
        label: type.label,
        value: type.id,
        ...(type.description ? { description: type.description } : {}),
      }))
    );
  const payload = {
    embeds: [new EmbedBuilder().setColor(0x4aa3df).setTitle(cfg.panelTitle).setDescription(cfg.panelText)],
    components: [new ActionRowBuilder().addComponents(menu)],
    allowedMentions: { parse: [] },
  };
  const old = cfg.panelMessageId ? await channel.messages.fetch(cfg.panelMessageId).catch(() => null) : null;
  if (old?.author.id === guild.members.me.id) return (await old.edit(payload)).id;
  return (await channel.send(payload)).id;
}

const locks = new Set();
const topicFor = (owner, type) => `sylo-ticket:${owner}:${type}:open`;
export const parseTicketTopic = (topic) =>
  /^sylo-ticket:(\d{17,20}):([a-zA-Z0-9_-]{1,50}):(open|closed)$/.exec(topic || '');
async function ticketLog(guild, cfg, title, fields) {
  return sendToChannel(guild.id, cfg.ticketLogChannel, {
    embeds: [new EmbedBuilder().setColor(0x4aa3df).setTitle(title).addFields(fields).setTimestamp()],
  });
}

// Fetch every page, including messages that are not in the bot cache.
export async function channelTicketTranscript(channel, ownerId, closerId) {
  const messages = [];
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    messages.push(...batch.values());
    const oldest = [...batch.keys()].reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
    if (oldest === before) throw new Error('Ticket history pagination did not advance.');
    before = oldest;
    if (batch.size < 100) break;
  }
  messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  const blocks = [
    `Ticket channel: #${channel.name || channel.id} (${channel.id})\nOwner: ${ownerId}\nClosed by: ${closerId}\nArchived: ${new Date().toISOString()}\nMessages: ${messages.length}\n\n`,
    ...messages.map((message) => {
      const lines = [
        `[${new Date(message.createdTimestamp).toISOString()}] ${message.author?.tag || 'Unknown'} (${message.author?.id || 'unknown'}) | Message ${message.id}`,
      ];
      if (message.content) lines.push(message.content);
      for (const embed of message.embeds || []) {
        if (embed.title) lines.push(`[Embed] ${embed.title}`);
        if (embed.description) lines.push(embed.description);
        for (const field of embed.fields || []) lines.push(`${field.name}: ${field.value}`);
        if (embed.image?.url) lines.push(`[Image] ${embed.image.url}`);
      }
      for (const file of message.attachments?.values() || [])
        lines.push(`[Attachment] ${file.name || 'file'}: ${file.url}`);
      return lines.join('\n') + '\n\n';
    }),
  ];
  const parts = [];
  let buffers = [];
  let size = 0;
  for (const block of blocks) {
    const bytes = Buffer.from(block, 'utf8');
    if (size && size + bytes.length > 7 * 1024 * 1024) {
      parts.push(Buffer.concat(buffers));
      buffers = [];
      size = 0;
    }
    buffers.push(bytes);
    size += bytes.length;
  }
  if (size) parts.push(Buffer.concat(buffers));
  return parts;
}

export async function archiveChannelTicket(guild, channel, cfg, ownerId, closerId) {
  if (!cfg.ticketLogChannel || cfg.ticketLogChannel === channel.id)
    throw new Error('Choose a separate ticket log channel before closing.');
  const parts = await channelTicketTranscript(channel, ownerId, closerId);
  for (let index = 0; index < parts.length; index++) {
    const sent = await sendToChannel(guild.id, cfg.ticketLogChannel, {
      embeds: [
        new EmbedBuilder()
          .setColor(0x8b95a1)
          .setTitle('Ticket closed')
          .addFields(
            { name: 'Member', value: `<@${ownerId}> (${ownerId})` },
            { name: 'Closed by', value: `<@${closerId}> (${closerId})` },
            { name: 'Channel', value: `#${channel.name || channel.id} (${channel.id})` },
            { name: 'Transcript', value: `Part ${index + 1}/${parts.length}` }
          )
          .setTimestamp(),
      ],
      files: [
        new AttachmentBuilder(parts[index], { name: `ticket-${channel.id}-transcript-${index + 1}.txt` }),
      ],
      allowedMentions: { parse: [] },
    });
    if (!sent) throw new Error('Transcript delivery failed; the ticket channel was retained.');
  }
  await channel.delete(`Ticket archived and closed by ${closerId}`);
}

export async function handleChannelTicket(interaction) {
  if (!interaction.guild || !(await isModuleEnabled(interaction.guildId, 'tickets'))) {
    return interaction.reply({
      content: 'Tickets are disabled in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const cfg = (await getGuildModule(guild.id, 'tickets')).config;
  const opening = interaction.customId === 'ticket-channel:open';
  const lock = opening ? `${guild.id}:${interaction.user.id}` : `${guild.id}:${interaction.channelId}`;
  if (locks.has(lock)) return interaction.editReply('A ticket action is already in progress.');
  locks.add(lock);
  try {
    if (opening) {
      if (!interaction.isStringSelectMenu()) return interaction.editReply('Wybierz temat zgłoszenia z menu.');
      if (interaction.channelId !== cfg.panelChannel || interaction.message.id !== cfg.panelMessageId)
        return interaction.editReply('This panel is outdated. Please use the current ticket panel.');
      const type = cfg.ticketTypes?.find((item) => item.id === interaction.values[0]);
      if (!type) return interaction.editReply('This ticket type is no longer available.');
      const existing = guild.channels.cache.find((channel) => {
        const match = parseTicketTopic(channel.topic);
        return match?.[1] === interaction.user.id && match[3] === 'open';
      });
      if (existing) return interaction.editReply(`You already have an open ticket: ${existing}`);
      const category = await guild.channels.fetch(type.categoryId);
      if (category?.type !== ChannelType.GuildCategory)
        return interaction.editReply('The ticket category is unavailable. Please contact staff.');
      const permissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ];
      const pingRoles = [...new Set([].concat(cfg.pingRoles || []))]
        .filter((role) => role !== guild.id && guild.roles.cache.has(role))
        .slice(0, 20);
      const staffRoles = [...new Set([...(cfg.staffRoles || []), ...pingRoles])].filter(
        (role) => role !== guild.id && guild.roles.cache.has(role)
      );
      const channel = await guild.channels.create({
        name: `ticket-${interaction.user.username.replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'member'}-${interaction.user.id.slice(-4)}`,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: topicFor(interaction.user.id, type.id),
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: permissions },
          { id: guild.members.me.id, allow: [...permissions, PermissionFlagsBits.ManageChannels] },
          ...staffRoles.map((role) => ({ id: role, allow: permissions })),
        ],
        reason: `Ticket opened by ${interaction.user.id}: ${type.label}`,
      });
      try {
        await channel.send({
          content: [`<@${interaction.user.id}>`, ...pingRoles.map((role) => `<@&${role}>`)].join(' '),
          allowedMentions: { parse: [], users: [interaction.user.id], roles: pingRoles },
          embeds: [
            new EmbedBuilder()
              .setColor(0x4aa3df)
              .setTitle(type.label)
              .setDescription('Opisz tutaj swoją sprawę. Administracja odpowie na tym kanale.'),
          ],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('ticket-channel:close')
                .setStyle(ButtonStyle.Danger)
                .setLabel('Zamknij zgłoszenie')
            ),
          ],
        });
      } catch (error) {
        await channel.delete('Ticket setup failed').catch(() => {});
        throw error;
      }
      await ticketLog(guild, cfg, 'Ticket opened', [
        { name: 'Member', value: `<@${interaction.user.id}> (${interaction.user.id})` },
        { name: 'Topic', value: type.label },
        { name: 'Channel', value: `${channel} (${channel.id})` },
      ]);
      return interaction.editReply(`Your ticket is ready: ${channel}`);
    }
    if (interaction.customId !== 'ticket-channel:close' || !interaction.isButton())
      return interaction.editReply('Unknown ticket action.');
    const channel = interaction.channel;
    const match = parseTicketTopic(channel?.topic);
    if (!match) return interaction.editReply('This ticket is already closed or unavailable.');
    const member = await guild.members.fetch(interaction.user.id);
    const staff =
      member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      (cfg.staffRoles || []).some((role) => member.roles.cache.has(role));
    if (match[1] !== interaction.user.id && !staff)
      return interaction.editReply('Only the ticket owner or staff may close this ticket.');
    if (!cfg.ticketLogChannel || cfg.ticketLogChannel === channel.id)
      return interaction.editReply(
        'Set a separate Ticket log channel in the dashboard before closing this ticket.'
      );
    await channel.permissionOverwrites.edit(match[1], {
      SendMessages: false,
      AddReactions: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false,
    });
    await channel.setTopic(`sylo-ticket:${match[1]}:${match[2]}:closed`);
    await archiveChannelTicket(guild, channel, cfg, match[1], interaction.user.id);
    return interaction.editReply('Ticket archived in the log channel and deleted.');
  } catch (error) {
    await interaction.editReply(
      'The ticket action failed. Ask staff to check the bot permissions and category settings.'
    );
    throw error;
  } finally {
    locks.delete(lock);
  }
}
registerComponent('tickets', 'ticket-channel:', handleChannelTicket);
