import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { execute } from '../src/bot/commands/massban.js';
import { punishmentCounts } from '../src/db/modCases.js';

const good = '100000000000000111';
const protectedId = '100000000000000112';
test('massban enforces hierarchy and records only successful bans', async () => {
  const banned = [];
  let result = '';
  const guild = { id: '100000000000000100', ownerId: protectedId, members: {
    me: { id: '100000000000000199', roles: { highest: { comparePositionTo: () => 1 } } },
    fetch: async ({ user }) => ({ id: user, bannable: true, roles: { highest: {} }, user: { tag: 'target' } }),
  }, bans: { create: async (id) => banned.push(id) } };
  const i = { guild, user: { id: '100000000000000188', tag: 'moderator' },
    member: { id: '100000000000000188', roles: { highest: { comparePositionTo: () => 1 } } },
    memberPermissions: { has: (p) => p === PermissionFlagsBits.BanMembers },
    options: { getString: (name) => name === 'users' ? `${good} ${protectedId}` : 'reason' },
    deferReply: async () => {}, editReply: async ({ content }) => { result = content; },
  };
  await execute(i);
  assert.deepEqual(banned, [good]);
  assert.match(result, /zbanowany/);
  assert.match(result, /hierarchia/);
  assert.equal(Number((await punishmentCounts(guild.id))[0].total), 1);
});
