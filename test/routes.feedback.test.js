import { startWebApp, post } from './helpers/webApp.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule } from '../src/db/modules.js';

test('V1 publishes feedback panel and exposes the module in overview and sidebar', async () => {
  const app = await startWebApp();
  try {
    const result = await post(app.base, `/guilds/${GID}/m/feedback/config`, {
      panelChannel: CH.general,
      reviewChannel: CH.bots,
      title: 'Complaints',
      subjectRoles: ROLE.member,
      buttonLabel: 'Write feedback',
      action: 'publish',
    });
    assert.equal(result.status, 302);
    const { config } = await getGuildModule(GID, 'feedback');
    assert.ok(config.panelMessageId);
    assert.equal(config.anonymous, false);
    assert.deepEqual(config.subjectRoles, [ROLE.member]);
    const page = await fetch(`${app.base}/guilds/${GID}/m/feedback?lang=en`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Staff review channel/);
    assert.match(html, /Roles shown in member picker/);
    const overview = await fetch(`${app.base}/guilds/${GID}/overview?lang=en`);
    assert.match(await overview.text(), /m\/feedback/);
  } finally {
    app.close();
  }
});

test('V2 saves and returns feedback privacy settings', async () => {
  const app = await startWebApp();
  try {
    const response = await fetch(`${app.base}/api/v2/guilds/${GID}/modules/feedback/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelChannel: CH.general, reviewChannel: CH.bots, anonymous: true }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).config.anonymous, true);
    const page = await fetch(`${app.base}/api/v2/guilds/${GID}/modules/feedback/config`);
    assert.equal(page.status, 200);
    assert.equal((await page.json()).config.reviewChannel, CH.bots);
  } finally {
    app.close();
  }
});
