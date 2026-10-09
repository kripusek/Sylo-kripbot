import { startWebApp, post } from './helpers/webApp.js';
import { GID, CH } from './helpers/fakeGuild.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule } from '../src/db/modules.js';

test('V1 logging saves per-event channels, validates IDs and renders selected values', async () => {
  const app = await startWebApp();
  try {
    const res = await post(app.base, `/guilds/${GID}/m/logging/config`, {
      channel: CH.general,
      ev_messageCreate: 'on',
      channel_messageCreate: CH.bots,
      channel_memberBan: 'invalid',
    });
    assert.equal(res.status, 302);
    const { config } = await getGuildModule(GID, 'logging');
    assert.equal(config.channel, CH.general);
    assert.equal(config.eventChannels.messageCreate, CH.bots);
    assert.equal(config.eventChannels.memberBan, '');
    assert.equal(config.events.messageCreate, true);
    const page = await fetch(`${app.base}/guilds/${GID}/m/logging`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Message sent/);
    assert.match(html, /Use default channel/);
    assert.match(html, new RegExp(`value="${CH.bots}" selected`));
  } finally {
    app.close();
  }
});
