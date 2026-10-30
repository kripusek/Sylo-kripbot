import './helpers/tmpDb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { runtime } from '../src/runtime.js';
import { logSentMessage, logChannel, logVoiceChange, findVoiceActor } from '../src/modules/logging.js';
import { dispatch } from '../src/modules/dispatch.js';
import { setGuildModule } from '../src/db/modules.js';

test('logging routes messages and simultaneous member changes to their chosen destinations', async () => {
  const sent = [];
  const channels = new Map(
    ['default', 'messages', 'members', 'penalties', 'roles'].map((id) => [
      id,
      {
        isTextBased: () => true,
        send: async (payload) => {
          sent.push({ id, embed: payload.embeds[0].toJSON() });
          return { id: 'result' };
        },
      },
    ])
  );
  runtime.client = {
    guilds: { cache: new Map([['guild', { channels: { cache: channels }, members: {} }]]) },
  };
  const config = {
    channel: 'default',
    events: { messageCreate: true, nickChange: true, memberTimeout: true, roleChange: true },
    eventChannels: {
      messageCreate: 'messages',
      nickChange: 'members',
      memberTimeout: 'penalties',
      roleChange: 'roles',
    },
  };
  assert.equal(logChannel(config, 'messageDelete'), 'default');
  assert.equal(logChannel({ eventChannels: config.eventChannels }, 'messageCreate'), 'messages');
  const message = {
    guildId: 'guild',
    channelId: 'source',
    channel: '#general',
    id: '123',
    url: 'https://discord.com/channels/1/2/3',
    author: { id: '456', tag: 'member' },
    content: 'a'.repeat(2000),
  };
  await logSentMessage(message, config, 'guild');
  assert.equal(sent[0].id, 'messages');
  assert.equal(sent[0].embed.fields[2].value.length, 1024);
  for (const override of [
    { author: { bot: true } },
    { webhookId: 'webhook' },
    { system: true },
    { guildId: null },
    { channelId: 'roles' },
  ]) {
    await logSentMessage({ ...message, ...override }, config, 'guild');
  }
  await logSentMessage(message, { ...config, events: {} }, 'guild');
  assert.equal(sent.length, 1);
  await setGuildModule('guild', 'logging', { enabled: true, config });
  const before = {
    nickname: 'old',
    communicationDisabledUntilTimestamp: null,
    roles: { cache: new Collection() },
  };
  const after = {
    id: '456',
    nickname: 'new',
    communicationDisabledUntilTimestamp: Date.now() + 60000,
    roles: { cache: new Collection([['role', { id: 'role', name: 'Role', toString: () => '<@&role>' }]]) },
  };
  await dispatch('guildMemberUpdate', 'guild', { old: before, new: after });
  assert.deepEqual(
    sent
      .slice(1)
      .map((entry) => entry.id)
      .sort(),
    ['members', 'penalties', 'roles']
  );
  runtime.client = null;
});

test('voice transitions use separate channels and ignore mute-only changes', async () => {
  const sent = [];
  const channels = new Map(
    ['joins', 'leaves', 'moves'].map((id) => [
      id,
      {
        isTextBased: () => true,
        send: async (payload) => {
          sent.push({ id, embed: payload.embeds[0].toJSON() });
          return { id: 'log' };
        },
      },
    ])
  );
  runtime.client = {
    guilds: { cache: new Map([['guild', { channels: { cache: channels }, members: {} }]]) },
  };
  const config = {
    events: { voiceJoin: true, voiceLeave: true, voiceMove: true },
    eventChannels: { voiceJoin: 'joins', voiceLeave: 'leaves', voiceMove: 'moves' },
  };
  const state = (channelId) => ({ id: 'member', channelId });
  await logVoiceChange({ old: state(null), new: state('vc1') }, config, 'guild');
  await logVoiceChange({ old: state('vc1'), new: state('vc2') }, config, 'guild');
  await logVoiceChange({ old: state('vc2'), new: state(null) }, config, 'guild');
  await logVoiceChange({ old: state('vc1'), new: { ...state('vc1'), selfMute: true } }, config, 'guild');
  await logVoiceChange({ old: state(null), new: state('vc1') }, { ...config, events: {} }, 'guild');
  assert.deepEqual(
    sent.map((entry) => entry.id),
    ['joins', 'moves', 'leaves']
  );
  assert.equal(sent[1].embed.fields.find((field) => field.name === 'From').value, '<#vc1>');
  assert.equal(sent[1].embed.fields.find((field) => field.name === 'To').value, '<#vc2>');
  runtime.client = null;
});

test('message logs preview images and link other attachments within Discord limits', async () => {
  let payload;
  runtime.client = {
    guilds: {
      cache: new Map([
        [
          'guild',
          {
            channels: {
              cache: new Map([
                [
                  'logs',
                  {
                    isTextBased: () => true,
                    send: async (data) => {
                      payload = data;
                      return { id: 'log' };
                    },
                  },
                ],
              ]),
            },
            members: {},
          },
        ],
      ]),
    },
  };
  const message = {
    guildId: 'guild',
    channelId: 'source',
    channel: '#general',
    id: '123',
    url: 'https://discord.com/channels/1/2/3',
    author: { id: '456', tag: 'member' },
    attachments: new Collection([
      [
        '1',
        {
          name: 'photo.png',
          contentType: 'image/png',
          url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
        },
      ],
      ['2', { name: 'second.jpg', url: 'https://cdn.discordapp.com/attachments/1/2/second.jpg' }],
      [
        '3',
        {
          name: 'file.pdf',
          contentType: 'application/pdf',
          url: 'https://cdn.discordapp.com/attachments/1/2/file.pdf',
        },
      ],
    ]),
  };
  await logSentMessage(message, { channel: 'logs', events: { messageCreate: true } }, 'guild');
  const embeds = payload.embeds.map((embed) => embed.toJSON());
  assert.equal(embeds.length, 2);
  assert.equal(embeds[0].image.url, message.attachments.get('1').url);
  assert.equal(embeds[1].image.url, message.attachments.get('2').url);
  assert.match(embeds[0].fields.find((field) => field.name === 'Attachments').value, /file.pdf/);
  assert.equal(embeds[0].fields.find((field) => field.name === 'Content').value, '*none*');
  runtime.client = null;
});

test('voice move log names the moderator who moved the member (matched by destination, credited once per entry)', async () => {
  const sent = [];
  runtime.client = {
    guilds: {
      cache: new Map([
        [
          'guild',
          {
            channels: {
              cache: new Map([
                [
                  'logs',
                  {
                    isTextBased: () => true,
                    send: async (p) => (sent.push(p.embeds[0].toJSON()), { id: 'x' }),
                  },
                ],
              ]),
            },
            members: {},
          },
        ],
      ]),
    },
  };
  const now = Date.now();
  const entry = (id, executorId, channelId, count, ageMs) => [
    id,
    {
      createdTimestamp: now - ageMs,
      executor: { id: executorId, tag: `${executorId}#0` },
      extra: { channel: { id: channelId }, count },
    },
  ];
  const guild = {
    fetchAuditLogs: async () => ({
      entries: new Map([entry('e1', 'mod', 'vc2', 1, 1000), entry('e0', 'old', 'vc2', 1, 60_000)]),
    }),
  };
  const config = { channel: 'logs', events: { voiceMove: true } };
  const state = (channelId, memberId = 'member') => ({ id: memberId, channelId, guild });

  // A self move to another channel / by the same user is not credited to anyone.
  assert.equal((await findVoiceActor(guild, 'move', 'mod', 'vc2')) ?? null, null);
  assert.equal((await findVoiceActor(guild, 'move', 'a', 'vc9')) ?? null, null);

  await logVoiceChange({ old: state('vc1'), new: state('vc2') }, config, 'guild', { delayMs: 0 });
  assert.match(sent[0].fields.find((f) => f.name === 'Moved by').value, /mod/);
  // The same single-person entry cannot be credited to a second member.
  await logVoiceChange({ old: state('vc1', 'other'), new: state('vc2', 'other') }, config, 'guild', {
    delayMs: 0,
  });
  assert.equal(
    sent[1].fields.find((f) => f.name === 'Moved by'),
    undefined
  );
  runtime.client = null;
});
