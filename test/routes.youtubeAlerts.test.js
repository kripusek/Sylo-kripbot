import { startWebApp, post } from './helpers/webApp.js';
import { GID, CH } from './helpers/fakeGuild.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule } from '../src/db/modules.js';

const rows = Array.from({ length: 5 }, (_, i) => ({
  ytChannelId: 'UC' + String(i).padStart(22, '0'),
  discordChannelId: CH.general,
  notify: 'both',
}));
function formBody(alerts) {
  const body = new URLSearchParams();
  for (const a of alerts) {
    body.append('yt_input', `https://www.youtube.com/channel/${a.ytChannelId}`);
    body.append('yt_resolvedId', a.ytChannelId);
    body.append('yt_resolvedName', '');
    body.append('yt_channel', a.discordChannelId);
    body.append('yt_notify', a.notify);
    body.append('yt_role', '');
    body.append('yt_onEnd', 'keep');
    body.append('yt_videoMessage', '');
    body.append('yt_liveMessage', '');
  }
  return body.toString();
}

test('V1 saves five YouTube rows and refuses incomplete/duplicate additions without losing saved rows', async () => {
  const app = await startWebApp();
  try {
    const path = `/guilds/${GID}/m/youtube-alerts/config`;
    const res = await post(app.base, path, formBody(rows));
    assert.equal(res.status, 302);
    const { config } = await getGuildModule(GID, 'youtube-alerts');
    assert.equal(config.alerts.length, 5);
    const page = await fetch(`${app.base}/guilds/${GID}/m/youtube-alerts`);
    const html = await page.text();
    for (const a of rows) assert.ok(html.includes(a.ytChannelId));
    assert.match(html, /channel-multi-picker/);
    assert.match(html, /yt_channels_0/);
    assert.match(html, /type="checkbox" name="yt_channels_0"/);
    assert.ok(html.includes('data-channel-search'));
    assert.match(html, new RegExp(`value="${CH.general}" checked`));
    for (const additional of [
      { ...rows[0], ytChannelId: 'UC' + 'z'.repeat(22), discordChannelId: '' },
      rows[0],
    ]) {
      const failed = await post(app.base, path, formBody([...rows, additional]), { 'HX-Request': 'true' });
      assert.equal(failed.status, 400);
      const message = await failed.text();
      assert.match(message, /Powiadomienie 6:/);
      assert.equal(JSON.parse(failed.headers.get('HX-Trigger')).toast.msg, message);
      assert.deepEqual((await getGuildModule(GID, 'youtube-alerts')).config, config);
    }
  } finally {
    app.close();
  }
});

test('V2 saves more than three YouTube rows and reports missing Discord destinations', async () => {
  const app = await startWebApp();
  const path = `/api/v2/guilds/${GID}/modules/youtube-alerts/config`;
  async function save(alerts) {
    return fetch(app.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alerts: alerts.map((a) => ({ ...a, input: a.ytChannelId })) }),
    });
  }
  try {
    const res = await save(rows);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).config.alerts.length, 5);
    const failed = await save([
      ...rows,
      { ...rows[0], ytChannelId: 'UC' + 'z'.repeat(22), discordChannelId: '' },
    ]);
    assert.equal(failed.status, 400);
    assert.match((await failed.json()).error, /Powiadomienie 6: wybierz kanał Discorda/);
    assert.equal((await getGuildModule(GID, 'youtube-alerts')).config.alerts.length, 5);
  } finally {
    app.close();
  }
});

test('V1 multiple destinations stay attached to the right YouTube row and survive reload', async () => {
  const app = await startWebApp();
  const body = new URLSearchParams();
  for (const [i, a] of rows.slice(0, 2).entries()) {
    body.append('yt_input', a.ytChannelId);
    body.append('yt_rowKey', `key${i}`);
    body.append('yt_notify', 'both');
    for (const id of i === 0 ? [CH.general, CH.bots] : [CH.announce]) body.append(`yt_channels_key${i}`, id);
  }
  try {
    const res = await post(app.base, `/guilds/${GID}/m/youtube-alerts/config`, body.toString());
    assert.equal(res.status, 302);
    const cfg = (await getGuildModule(GID, 'youtube-alerts')).config;
    assert.deepEqual(
      cfg.alerts.map((a) => a.discordChannelIds),
      [[CH.general, CH.bots], [CH.announce]]
    );
    const page = await fetch(`${app.base}/guilds/${GID}/m/youtube-alerts`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /yt_channels_1/);
    assert.ok(html.includes(CH.bots));
    const invalid = new URLSearchParams(body);
    invalid.delete('yt_channels_key1');
    const failure = await post(app.base, `/guilds/${GID}/m/youtube-alerts/config`, invalid.toString());
    assert.equal(failure.status, 400);
    assert.deepEqual((await getGuildModule(GID, 'youtube-alerts')).config, cfg);
  } finally {
    app.close();
  }
});

test('V2 stores one YouTube subscription with multiple destinations', async () => {
  const app = await startWebApp();
  try {
    const res = await fetch(`${app.base}/api/v2/guilds/${GID}/modules/youtube-alerts/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alerts: [{ input: rows[0].ytChannelId, discordChannelIds: [CH.general, CH.bots], notify: 'both' }],
      }),
    });
    assert.equal(res.status, 200);
    const cfg = (await res.json()).config;
    assert.equal(cfg.alerts.length, 1);
    assert.deepEqual(cfg.alerts[0].discordChannelIds, [CH.general, CH.bots]);
    assert.equal(cfg.alerts[0].discordChannelId, CH.general);
  } finally {
    app.close();
  }
});
