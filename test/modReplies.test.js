import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { execute as warn } from '../src/bot/commands/warn.js';

const G = '111111111111111111';

function fakeInteraction(sub, options) {
  const calls = { defer: [], reply: [], edit: [] };
  const moderator = { id: '222222222222222222', tag: 'mod', username: 'mod', displayAvatarURL: () => null };
  return {
    calls,
    guild: { id: G, name: 'Test', channels: { cache: new Map() }, members: { me: null } },
    client: { users: { fetch: async () => target } },
    user: moderator,
    options: {
      getSubcommand: () => sub,
      getUser: () => options.user,
      getString: () => options.reason,
      getInteger: () => options.id,
    },
    deferReply: async (o) => void calls.defer.push(o),
    reply: async (o) => void calls.reply.push(o),
    editReply: async (o) => void calls.edit.push(o),
  };
}

const target = {
  id: '333333333333333333',
  tag: 'target',
  username: 'target',
  bot: false,
  displayAvatarURL: () => null,
  send: async () => {},
};

test('/warn add, remove and clear answer only the moderator', async () => {
  const add = fakeInteraction('add', { user: target, reason: 'spam' });
  await warn(add);
  assert.equal(add.calls.defer[0]?.flags, MessageFlags.Ephemeral);
  assert.equal(add.calls.edit.length, 1);

  const { listWarnings } = await import('../src/db/modCases.js');
  const [row] = await listWarnings(G, target.id);
  const remove = fakeInteraction('remove', { id: row.id });
  await warn(remove);
  assert.equal(remove.calls.defer[0]?.flags, MessageFlags.Ephemeral);

  const clear = fakeInteraction('clear', { user: target });
  await warn(clear);
  assert.equal(clear.calls.reply[0]?.flags, MessageFlags.Ephemeral);
});
