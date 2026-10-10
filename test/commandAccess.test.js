import './helpers/tmpDb.js';
import './helpers/openMode.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js';
import { moderationPermissions, commandDefinitionForRegistration } from '../src/bot/lib/commandAccess.js';
import { overrideBlockReason } from '../src/bot/events/interactionCreate.js';
import { setCommandOverride } from '../src/db/commandOverrides.js';
import { fakeCommandInteraction } from './helpers/fakeInteraction.js';

const guildId = '810000000000000001';
const role = '810000000000000002';
function interaction(commandName, roleIds = [], permissions = []) {
  const i = fakeCommandInteraction({ guildId, commandName, channelId: '810000000000000003', roleIds });
  i.memberPermissions = { has: (permission) => permissions.includes(permission) };
  return i;
}

test('delegated moderation commands fail closed and retain native permission defaults', async () => {
  for (const [name, permission] of Object.entries(moderationPermissions)) {
    assert.match(await overrideBlockReason(interaction(name)), /permission/);
    assert.equal(await overrideBlockReason(interaction(name, [], [permission])), null);
    await setCommandOverride(guildId, name, { enabled: true, allowedRoles: [role] });
    assert.equal(await overrideBlockReason(interaction(name, [role])), null);
    assert.match(await overrideBlockReason(interaction(name, [], [permission])), /role allowed/);
    assert.equal(await overrideBlockReason(interaction(name, [], [P.Administrator])), null);
    const raw = interaction(name);
    raw.member.roles = [role];
    assert.equal(await overrideBlockReason(raw), null);
    await setCommandOverride(guildId, name, { allowedChannels: ['810000000000000004'] });
    assert.match(await overrideBlockReason(interaction(name, [role])), /only be used in/);
    await setCommandOverride(guildId, name, { enabled: false });
    assert.match(await overrideBlockReason(interaction(name, [], [P.Administrator])), /disabled/);
    await setCommandOverride(guildId, name, { enabled: true, allowedRoles: [], allowedChannels: [] });
    assert.match(await overrideBlockReason(interaction(name)), /permission/);
    const missing = interaction(name);
    delete missing.memberPermissions;
    assert.match(await overrideBlockReason(missing), /permission/);
  }
});

test('registration opens only delegated commands, without mutating builders', () => {
  for (const [name, permission] of Object.entries(moderationPermissions)) {
    const command = {
      data: new SlashCommandBuilder()
        .setName(name)
        .setDescription('Test')
        .setDefaultMemberPermissions(permission),
    };
    assert.equal(commandDefinitionForRegistration(command).default_member_permissions, null);
    assert.equal(command.data.toJSON().default_member_permissions, String(permission));
  }
  const admin = {
    data: new SlashCommandBuilder()
      .setName('modlog')
      .setDescription('Test')
      .setDefaultMemberPermissions(P.ManageGuild),
  };
  assert.equal(commandDefinitionForRegistration(admin).default_member_permissions, String(P.ManageGuild));
});
