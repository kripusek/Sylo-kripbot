import './helpers/tmpDb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { runtime } from '../src/runtime.js';
import { logSentMessage, logChannel, logVoiceChange } from '../src/modules/logging.js';
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
