import './helpers/tmpDb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { runtime } from '../src/runtime.js';
import { logSentMessage, logChannel } from '../src/modules/logging.js';
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
