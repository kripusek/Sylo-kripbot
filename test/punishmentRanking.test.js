import { startWebApp, post } from './helpers/webApp.js';
import { GID, ROLE } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { addCase, setCaseActive } from '../src/db/modCases.js';

const moderator = '100000000000001234';
let app;
test.before(async () => {
  app = await startWebApp();
  app.guild.members.fetch = async (id) => ({ id, displayName: 'Test Moderator', roles: { cache: new Map([[ROLE.admin, {}]]) } });
});
test.after(() => app.close());

test('role settings filter recorded punishment counts and exclude notes and automatic actions', async () => {
  const url = `/guilds/${GID}/punishment-ranking`;
  for (const [action, moderatorId] of [['warn', moderator], ['ban', moderator], ['note', moderator], ['ban', 'auto']]) {
    await addCase({ guildId: GID, userId: '100000000000009999', moderatorId, action });
  }
  await setCaseActive(GID, 2, false);
  let page = await (await fetch(app.base + url)).text();
  assert.match(page, /Wybierz przynajmniej jedną rolę/);
  assert.match(page, /href="\/guilds\/900000000000000123\/punishment-ranking"/);
  assert.match(page, /Ranking kar/);
  assert.doesNotMatch(page, /Test Moderator/);
  const saved = await post(app.base, url, { roles: ROLE.admin });
  assert.equal(saved.status, 302);
  page = await (await fetch(app.base + url)).text();
  assert.match(page, /Test Moderator/);
  const api = await (await fetch(app.base + `/api/v2/guilds/${GID}/punishment-ranking`)).json();
  assert.deepEqual(api.selected, [ROLE.admin]);
  assert.equal(api.ranking[0].total, 2);
  assert.match(page, /<td>1<\/td><td>0<\/td><td>0<\/td><td>1<\/td><td>2<\/td>/);
  const removed = await post(app.base, url, '');
  assert.equal(removed.status, 302);
  page = await (await fetch(app.base + url)).text();
  assert.doesNotMatch(page, /Test Moderator/);
});

test('individual moderators can be included without selecting a role', async () => {
  const url = `/guilds/${GID}/punishment-ranking`;
  await post(app.base, url, { users: moderator });
  const page = await (await fetch(app.base + url)).text();
  assert.match(page, /Test Moderator/);
  assert.match(page, new RegExp(moderator));
});
