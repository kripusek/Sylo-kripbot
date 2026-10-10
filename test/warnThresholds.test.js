import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWarnThresholds, normaliseThresholds, settleTempBan } from '../src/modules/moderation.js';
import { setGuildModule } from '../src/db/modules.js';
import { getTempBan, scheduleTempBan } from '../src/db/tempBans.js';
import { runtime } from '../src/runtime.js';

const user = {
  id: '800000000000000001',
  tag: 'test',
  displayAvatarURL: () => 'https://example.com/avatar.png',
};
function guild(id) {
  const calls = [];
  return {
    id,
    name: 'Test',
    calls,
    members: { me: { permissions: { has: () => true } }, fetch: async () => null },
    bans: {
      create: async (...args) => calls.push(args),
      fetch: async () => ({}),
      remove: async () => calls.push('unban'),
    },
  };
}

test('default warning policy is 3 -> 30 days, 5 -> permanent; permanent duration survives saves', () => {
  assert.deepEqual(normaliseThresholds([]), [
    { count: 3, action: 'ban', durationMinutes: 43200 },
    { count: 5, action: 'ban', durationMinutes: 0 },
  ]);
  assert.equal(
    normaliseThresholds([{ count: 5, action: 'ban', durationMinutes: '0' }])[0].durationMinutes,
    0
  );
  assert.deepEqual(normaliseThresholds([null]), []);
});

test('third warning schedules 30 days; fourth does not extend; fifth cancels auto-unban', async () => {
  const g = guild('900000000000000001');
  await setGuildModule(g.id, 'moderation', { enabled: true, config: { dmOnPunish: false } });
  await applyWarnThresholds(g, user, 2, 'mod');
  assert.equal(g.calls.length, 0);
  const before = Date.now();
  await applyWarnThresholds(g, user, 3, 'mod');
  const scheduled = await getTempBan(g.id, user.id);
  assert.ok(scheduled.unban_at >= before + 30 * 86400000);
  assert.ok(scheduled.unban_at <= Date.now() + 30 * 86400000);
  await applyWarnThresholds(g, user, 4, 'mod');
  assert.equal((await getTempBan(g.id, user.id)).unban_at, scheduled.unban_at);
  assert.equal(g.calls.length, 1);
  await applyWarnThresholds(g, user, 5, 'mod');
  assert.equal(await getTempBan(g.id, user.id), null);
  runtime.client = { guilds: { cache: new Map([[g.id, g]]) } };
  await settleTempBan(scheduled);
  assert.equal(g.calls.length, 2, 'stale expiry must not unban permanent punishment');
});

test('expiry retains schedule on network failures and missing permissions, then retries successfully', async () => {
  const g = guild('900000000000000002');
  await scheduleTempBan({
    guildId: g.id,
    userId: user.id,
    modId: 'auto',
    reason: 'test',
    unbanAt: Date.now() - 1,
  });
  const row = await getTempBan(g.id, user.id);
  runtime.client = { guilds: { cache: new Map([[g.id, g]]) } };
  g.members.me.permissions.has = () => false;
  await settleTempBan(row);
  assert.ok(await getTempBan(g.id, user.id));
  g.members.me.permissions.has = () => true;
  g.bans.fetch = async () => {
    throw new Error('network');
  };
  await assert.rejects(settleTempBan(row), /network/);
  assert.ok(await getTempBan(g.id, user.id));
  g.bans.fetch = async () => ({});
  g.bans.remove = async () => {
    throw new Error('rate limit');
  };
  await assert.rejects(settleTempBan(row), /rate limit/);
  assert.ok(await getTempBan(g.id, user.id));
  g.bans.remove = async () => g.calls.push('unban');
  await Promise.all([settleTempBan(row), settleTempBan(row)]);
  assert.deepEqual(g.calls, ['unban']);
  assert.equal(await getTempBan(g.id, user.id), null);
});

test('failed ban does not create a scheduled unban, and disabled moderation does not punish', async () => {
  const g = guild('900000000000000003');
  await setGuildModule(g.id, 'moderation', { enabled: true, config: { dmOnPunish: false } });
  g.bans.create = async () => {
    throw new Error('Missing Permissions');
  };
  await applyWarnThresholds(g, user, 3, 'mod');
  assert.equal(await getTempBan(g.id, user.id), null);
  await setGuildModule(g.id, 'moderation', { enabled: false });
  g.bans.create = async () => g.calls.push('ban');
  await applyWarnThresholds(g, user, 5, 'mod');
  assert.equal(g.calls.length, 0);
});
