import './helpers/tmpDb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  normaliseChannelTickets,
  publishTicketPanel,
  handleChannelTicket,
  archiveChannelTicket,
  channelTicketTranscript,
} from '../src/modules/channelTickets.js';
import { setGuildModule } from '../src/db/modules.js';
import { runtime } from '../src/runtime.js';

const guildId = '900000000000000123';
const ownerId = '900000000000000456';
const botId = '900000000000000789';
const categoryId = '100000000000000005';
const panelId = '100000000000000001';
const logId = '100000000000000002';
const cfg = {
  ...normaliseChannelTickets({
    panelChannel: panelId,
    ticketLogChannel: logId,
    ticketTypes: [{ id: 'support', label: 'Support', categoryId }],
  }),
  panelMessageId: 'panel',
  staffRoles: ['100000000000000700'],
  pingRoles: ['100000000000000701', '100000000000000701', guildId, 'missing'],
};

test('ticket settings limit topics, keep stable IDs, and discard forged panel message IDs', () => {
  const result = normaliseChannelTickets(
    {
      ...cfg,
      panelMessageId: 'forged',
      ticketTypes: [
        { id: 'support', label: ' Support ', categoryId },
        { id: 'support', label: 'Other', categoryId },
        { label: '' },
      ],
    },
    cfg
  );
  assert.equal(result.panelMessageId, 'panel');
  assert.equal(result.ticketTypes.length, 2);
  assert.equal(result.ticketTypes[0].id, 'support');
  assert.notEqual(result.ticketTypes[1].id, 'support');
  assert.equal(normaliseChannelTickets({ panelChannel: logId }, cfg).panelMessageId, '');
  assert.equal(
    normaliseChannelTickets({ ticketTypes: Array.from({ length: 30 }, (_, i) => ({ label: `Type ${i}` })) })
      .ticketTypes.length,
    25
  );
});

test('ticket panel edits an existing message with dropdown options', async () => {
  let payload;
  const guild = {
    members: { me: { id: botId } },
    channels: {
      fetch: async (id) =>
        id === categoryId
          ? { type: ChannelType.GuildCategory }
          : {
              isTextBased: () => true,
              permissionsFor: () => ({ has: () => true }),
              messages: {
                fetch: async () => ({
                  author: { id: botId },
                  edit: async (data) => {
                    payload = data;
                    return { id: 'panel' };
                  },
                }),
              },
            },
    },
  };
  assert.equal(await publishTicketPanel(guild, cfg), 'panel');
  assert.equal(payload.components[0].toJSON().components[0].custom_id, 'ticket-channel:start');
  await assert.rejects(() => publishTicketPanel(guild, { ...cfg, ticketTypes: [] }), /at least one/);
});

test('private tickets route to a category, reject duplicates and unauthorized closure, and survive config reloads', async () => {
  const sent = [];
  const created = [];
  const edits = [];
  const cache = new Collection([
    [categoryId, { id: categoryId, type: ChannelType.GuildCategory }],
    [
      logId,
      {
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => true }),
        send: async (data) => {
          sent.push(data);
          return { id: 'log' };
        },
      },
    ],
  ]);
  const channel = {
    id: '100000000000001234',
    messages: { fetch: async () => new Collection() },
    delete: async () => {
      channel.deleted = true;
      cache.delete(channel.id);
    },
    toString: () => '<#100000000000001234>',
    send: async (data) => {
      sent.push(data);
    },
    permissionOverwrites: { edit: async (id, patch) => edits.push({ id, patch }) },
    setTopic: async (topic) => {
      channel.topic = topic;
    },
  };
  const guild = {
    id: guildId,
    roles: {
      cache: new Collection([
        ['100000000000000700', {}],
        ['100000000000000701', {}],
      ]),
    },
    members: {
      me: { id: botId },
      fetch: async () => ({ permissions: { has: () => false }, roles: { cache: new Collection() } }),
    },
    channels: {
      cache,
      fetch: async (id) => cache.get(id),
      create: async (options) => {
        created.push(options);
        channel.topic = options.topic;
        cache.set(channel.id, channel);
        return channel;
      },
    },
  };
  runtime.client = { guilds: { cache: new Collection([[guildId, guild]]) } };
  await setGuildModule(guildId, 'tickets', { enabled: true, config: cfg });
  const interaction = (customId, userId = ownerId) => ({
    guild,
    guildId,
    customId,
    user: { id: userId, username: 'member' },
    channelId: customId.endsWith('open') ? panelId : channel.id,
    channel,
    message: { id: 'panel' },
    values: ['support'],
    isStringSelectMenu: () => true,
    isButton: () => true,
    deferReply: async () => {},
    editReply: async (text) => {
      interaction.lastReply = text;
    },
  });
  const submitted = interaction(`ticket-channel:submit:${ownerId}:support`);
  submitted.channelId = panelId;
  submitted.isModalSubmit = () => true;
  submitted.fields = { getTextInputValue: (key) => (key === 'title' ? 'Prośba o pomoc' : 'Opis problemu') };
  await handleChannelTicket(submitted);
  assert.equal(created.length, 1);
  assert.equal(created[0].parent, categoryId);
  const opening = sent.find((entry) => entry.content?.includes(`<@${ownerId}>`));
  assert.equal(opening.content, `<@${ownerId}> <@&100000000000000701>`);
  assert.deepEqual(opening.allowedMentions.roles, ['100000000000000701']);
  assert.deepEqual(opening.allowedMentions.parse, []);
  assert.equal(opening.embeds[0].toJSON().title, 'Prośba o pomoc');
  assert.match(opening.embeds[0].toJSON().description, /Opis problemu/);
  assert.equal(opening.components[0].toJSON().components[1].custom_id, 'ticket-channel:call');
  assert.ok(created[0].permissionOverwrites.some((entry) => entry.id === '100000000000000701'));
  assert.deepEqual(normaliseChannelTickets(cfg).pingRoles, ['100000000000000701', guildId]);
  assert.equal(created[0].permissionOverwrites[0].deny[0], PermissionFlagsBits.ViewChannel);
  assert.equal(created[0].permissionOverwrites[1].id, ownerId);
  await handleChannelTicket(interaction('ticket-channel:open'));
  assert.equal(created.length, 1);
  assert.match(interaction.lastReply, /already have an open ticket/);
  await handleChannelTicket(interaction('ticket-channel:close', '900000000000000999'));
  assert.equal(edits.length, 0);
  await handleChannelTicket(interaction('ticket-channel:close'));
  assert.equal(edits[0].id, ownerId);
  assert.equal(edits[0].patch.SendMessages, false);
  assert.match(channel.topic, /:closed$/);
  assert.equal(sent.filter((entry) => entry.embeds?.[0]?.data.title === 'Ticket opened').length, 1);
  assert.equal(sent.filter((entry) => entry.embeds?.[0]?.data.title === 'Ticket closed').length, 1);
  assert.equal(channel.deleted, true);
  assert.ok(sent.at(-1).files[0].attachment.toString().includes(ownerId));

  runtime.client = null;
});

test('ticket transcript fetches multiple history pages in chronological order', async () => {
  const requests = [];
  const message = (id) => ({
    id: String(id),
    createdTimestamp: 0,
    content: `Text ${id}`,
    author: { id: ownerId, tag: 'owner' },
    attachments: new Collection(),
    embeds: [],
  });
  const channel = {
    id: 'channel',
    name: 'ticket',
    messages: {
      fetch: async (options) => {
        requests.push(options);
        return options.before
          ? new Collection([
              [
                '1',
                {
                  ...message(1),
                  attachments: new Collection([
                    ['a', { name: 'image.png', url: 'https://cdn.discordapp.com/image.png' }],
                  ]),
                },
              ],
            ])
          : new Collection(Array.from({ length: 100 }, (_, i) => [String(i + 2), message(i + 2)]));
      },
    },
  };
  const parts = await channelTicketTranscript(channel, ownerId, 'staff');
  const text = parts[0].toString();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].before, '2');
  assert.match(text, /Messages: 101/);
  assert.ok(text.indexOf('Text 1\n') < text.indexOf('Text 101\n'));
  assert.match(text, /image.png/);
});

test('ticket channel is deleted only after transcript delivery succeeds', async () => {
  let deleted = false;
  let delivered = false;
  let fail = true;
  const channel = {
    id: 'ticket',
    name: 'ticket',
    messages: { fetch: async () => new Collection() },
    delete: async () => {
      assert.equal(delivered, true);
      deleted = true;
    },
  };
  const log = {
    isTextBased: () => true,
    send: async () => {
      if (fail) throw new Error('Upload failed');
      delivered = true;
      return { id: 'archive' };
    },
  };
  const guild = { id: guildId, channels: { cache: new Collection([[logId, log]]) }, members: {} };
  runtime.client = { guilds: { cache: new Collection([[guildId, guild]]) } };
  await assert.rejects(() => archiveChannelTicket(guild, channel, cfg, ownerId, 'staff'), /delivery failed/);
  assert.equal(deleted, false);
  fail = false;
  await archiveChannelTicket(guild, channel, cfg, ownerId, 'staff');
  assert.equal(deleted, true);
  await assert.rejects(
    () => archiveChannelTicket(guild, channel, { ...cfg, ticketLogChannel: 'ticket' }, ownerId, 'staff'),
    /separate/
  );
  runtime.client = null;
});

test('ticket button opens a private picker, then a Polish title/description modal', async () => {
  const panelMessageId = '100000000000000999';
  await setGuildModule(guildId, 'tickets', { enabled: true, config: { ...cfg, panelMessageId } });
  let response;
  let modal;
  const i = {
    guild: { id: guildId },
    guildId,
    channelId: panelId,
    message: { id: panelMessageId },
    user: { id: ownerId },
    customId: 'ticket-channel:start',
    isButton: () => true,
    isStringSelectMenu: () => true,
    reply: async (value) => {
      response = value;
    },
    showModal: async (value) => {
      modal = value.toJSON();
    },
  };
  await handleChannelTicket(i);
  assert.equal(response.flags, 64);
  i.customId = response.components[0].toJSON().components[0].custom_id;
  i.values = ['support'];
  await handleChannelTicket(i);
  assert.equal(modal.title, 'Otwórz ticket');
  assert.equal(modal.components[0].components[0].label, 'Tytuł');
  assert.equal(modal.components[1].components[0].label, 'Opis');
  i.user.id = '900000000000000999';
  modal = null;
  await handleChannelTicket(i);
  assert.equal(modal, null);
  assert.match(response.content, /własny formularz/);
});

test('ticket form editor normalizes labels, field count, styles and optional fields', async () => {
  const { ticketFormFields } = await import('../src/modules/channelTickets.js');
  const config = normaliseChannelTickets({
    formTitle: 'Kontakt',
    formFields: [
      { label: 'Temat sprawy', placeholder: 'Krótko opisz temat', style: 'short', required: true },
      { label: 'Dodatkowe informacje', style: 'paragraph', required: false },
    ],
  });
  assert.equal(config.formTitle, 'Kontakt');
  assert.equal(config.formFields[0].placeholder, 'Krótko opisz temat');
  assert.equal(config.formFields[1].required, false);
  assert.equal(
    ticketFormFields({ formFields: Array.from({ length: 8 }, () => ({ label: 'Pytanie' })) }).length,
    5
  );
  assert.equal(ticketFormFields({ formFields: [] }).length, 2);
  assert.equal(
    ticketFormFields({
      formFields: [{ label: 'A'.repeat(100), placeholder: 'B'.repeat(200), style: 'bad' }],
    })[0].label.length,
    45
  );
});
