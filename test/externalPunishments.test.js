import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent } from 'discord.js';
import { execute } from '../src/bot/events/auditPunishments.js';
import { punishmentCounts } from '../src/db/modCases.js';

const guild = { id: '100000000000000101', client: { user: { id: '100000000000000102' } } };
const base = { id: '100000000000000103', executorId: '100000000000000104', targetId: '100000000000000105', action: AuditLogEvent.MemberBanAdd, createdTimestamp: Date.now() };
test('Discord actions are idempotent, attributed and skip Sylo actions', async () => {
  await execute(base, guild);
  await execute(base, guild);
  await execute({ ...base, id: '100000000000000106', executorId: guild.client.user.id }, guild);
  await execute({ ...base, id: '100000000000000107', action: AuditLogEvent.MemberUpdate, changes: [{ key: 'communication_disabled_until', new: new Date(Date.now() + 60000).toISOString() }] }, guild);
  await execute({ ...base, id: '100000000000000108', action: AuditLogEvent.MemberUpdate, changes: [{ key: 'communication_disabled_until', new: null }] }, guild);
  const rows = await punishmentCounts(guild.id);
  assert.deepEqual(rows.map((r) => [r.action, Number(r.total)]).sort(), [['ban', 1], ['timeout', 1]]);
});
