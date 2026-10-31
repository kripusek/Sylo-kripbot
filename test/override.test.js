import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { grantOverride, isOverrideUser, overrideAllowedIn } from '../src/modules/override.js';
import { getBotMasterRoles } from '../src/db/guildSettings.js';
import { listAudit } from '../src/db/audit.js';

const OP = '100000000000000001';
const OTHER = '100000000000000002';
const GUILD = '800000000000000071';

function fakeGuild({
  botPerms = [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.Administrator],
  existing = null,
} = {}) {
  const added = [];
  const created = [];
  const roles = new Map(existing ? [[existing.id, existing]] : []);
  const guild = {
    id: GUILD,
    members: {
      me: {
        permissions: { has: (flag) => botPerms.includes(flag) },
        roles: { highest: { position: 10 } },
      },
      fetch: async (id) => ({ id, roles: { add: async (role) => added.push([id, role.id]) } }),
    },
    roles: {
      cache: { find: (fn) => [...roles.values()].find(fn) },
      create: async (data) => {
        const role = {
          id: '900000000000000001',
          name: data.name,
          managed: false,
          comparePositionTo: () => -1,
        };
        created.push(data);
        roles.set(role.id, role);
        return role;
      },
    },
  };
  return { guild, added, created };
}

test('only OVERRIDE_ID accounts (in allowed guilds) can use the override', async () => {
  delete process.env.OVERRIDE_ID;
  delete process.env.OVERRIDE_GUILD_IDS;
  assert.equal(isOverrideUser(OP), false, 'nothing configured: nobody');
  assert.equal((await grantOverride(fakeGuild().guild, OP)).ok, false);

  process.env.OVERRIDE_ID = `${OP}, 123`;
  assert.equal(isOverrideUser(OP), true);
  assert.equal(isOverrideUser(OTHER), false);
  assert.equal((await grantOverride(fakeGuild().guild, OTHER)).ok, false);

  process.env.OVERRIDE_GUILD_IDS = '800000000000000099';
  assert.equal(overrideAllowedIn(GUILD), false);
  assert.match((await grantOverride(fakeGuild().guild, OP)).error, /nie jest włączony/);
  delete process.env.OVERRIDE_GUILD_IDS;
  delete process.env.OVERRIDE_ID;
});

test('override creates the role, assigns it, registers it as a dashboard master role and audits', async () => {
  process.env.OVERRIDE_ID = OP;
  const { guild, added, created } = fakeGuild();
  const result = await grantOverride(guild, OP);
  assert.equal(result.ok, true);
  assert.equal(result.administrator, true);
  assert.deepEqual(created[0].permissions, [PermissionFlagsBits.Administrator]);
  assert.equal(created[0].position, 9);
  assert.deepEqual(added, [[OP, '900000000000000001']]);
  assert.deepEqual(await getBotMasterRoles(GUILD), ['900000000000000001']);
  assert.equal((await listAudit(GUILD, 5))[0].action, 'override');

  // Second use reuses the role instead of creating another.
  const again = fakeGuild({
    existing: {
      id: '900000000000000001',
      name: 'Sylo Override',
      managed: false,
      comparePositionTo: () => -1,
    },
  });
  assert.equal((await grantOverride(again.guild, OP)).ok, true);
  assert.equal(again.created.length, 0);
  assert.deepEqual(await getBotMasterRoles(GUILD), ['900000000000000001']);

  // Without Administrator the role carries no Discord permissions; without Manage Roles it fails.
  const plain = fakeGuild({ botPerms: [PermissionFlagsBits.ManageRoles] });
  const r = await grantOverride(plain.guild, OP);
  assert.equal(r.administrator, false);
  assert.deepEqual(plain.created[0].permissions, []);
  assert.match((await grantOverride(fakeGuild({ botPerms: [] }).guild, OP)).error, /Zarządzanie rolami/);
  delete process.env.OVERRIDE_ID;
});
