import { startWebApp } from './helpers/webApp.js';
import { GID, CH } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { credit, getAccount } from '../src/db/economy.js';
import { placeBet } from '../src/modules/markets.js';

const U1 = '700000000000000051';
const U2 = '700000000000000052';

test('markets dashboard: module page, create, publish, settle, delete — V1 and V2', async () => {
  const app = await startWebApp();
  try {
    await setGuildModule(GID, 'economy', { enabled: true, config: { startingBalance: 0 } });
    await setGuildModule(GID, 'markets', { enabled: true, config: { minBet: 10, maxBet: 500 } });

    const page = await fetch(`${app.base}/guilds/${GID}/m/markets`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /marketsAdmin/);
    assert.match(html, /Minimalna stawka/);

    const call = (path, body) =>
      fetch(`${app.base}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });

    const bad = await call(`/guilds/${GID}/markets/create`, { question: 'x', options: 'a' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /pytanie/i);

    const created = await call(`/guilds/${GID}/markets/create`, {
      question: 'Kto wygra?',
      options: 'Alfa\nBeta',
      channelId: CH.general,
      publish: true,
    });
    assert.equal(created.status, 200);
    const { id, warning } = await created.json();
    assert.ok(id);
    assert.equal(warning, null);
    const post = app.sink.messages.find((m) => m.channel === CH.general);
    assert.ok(post, 'the market message was posted');
    assert.equal(post.payload.components[0].components.length, 2, 'one button per option');

    const overview = await (await call(`/guilds/${GID}/markets/overview`)).json();
    assert.equal(overview.markets[0].question, 'Kto wygra?');
    assert.equal(overview.markets[0].published, true);
    assert.equal(overview.config.minBet, 10);

    await credit(GID, U1, 300);
    await credit(GID, U2, 300);
    assert.equal((await placeBet(GID, U1, id, 0, 100)).ok, true);
    assert.equal((await placeBet(GID, U2, id, 1, 200)).ok, true);

    assert.equal(
      (await call(`/guilds/${GID}/markets/${id}/delete`, {})).status,
      400,
      'open markets cannot be deleted'
    );
    assert.equal((await call(`/guilds/${GID}/markets/999999/settle`, { winner: 0 })).status, 404);
    assert.equal((await call(`/guilds/${GID}/markets/${id}/settle`, { winner: 9 })).status, 400);

    const settled = await call(`/api/v2/guilds/${GID}/modules/markets/${id}/settle`, { winner: 1 });
    assert.equal(settled.status, 200);
    assert.equal((await settled.json()).paid, 300);
    assert.equal((await getAccount(GID, U2)).balance, 400);
    assert.equal((await getAccount(GID, U1)).balance, 200);
    assert.equal(
      (await call(`/guilds/${GID}/markets/${id}/settle`, { winner: 0 })).status,
      400,
      'settling twice is refused'
    );

    const v2 = await (await call(`/api/v2/guilds/${GID}/modules/markets/overview`)).json();
    assert.equal(v2.markets[0].status, 'resolved');

    const saved = await call(`/api/v2/guilds/${GID}/modules/markets/settings`, {
      minBet: 20,
      maxBet: 10,
      channelId: CH.general,
    });
    assert.deepEqual((await saved.json()).config, { minBet: 20, maxBet: 20, channelId: CH.general });

    assert.equal((await call(`/guilds/${GID}/markets/${id}/delete`, {})).status, 200);
    assert.equal((await (await call(`/guilds/${GID}/markets/overview`)).json()).markets.length, 0);
  } finally {
    app.close();
  }
});

test('markets V1 settings form saves through the module config route', async () => {
  const app = await startWebApp();
  try {
    const res = await fetch(`${app.base}/guilds/${GID}/m/markets/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ minBet: '25', maxBet: '900', channelId: CH.announce }).toString(),
      redirect: 'manual',
    });
    assert.ok(res.status < 400);
    const view = await (await fetch(`${app.base}/guilds/${GID}/m/markets`)).text();
    assert.match(view, /value="25"/);
    assert.match(view, /value="900"/);
  } finally {
    app.close();
  }
});

test('CS2 match market can be created from the dashboard', async () => {
  const app = await startWebApp();
  try {
    delete process.env.LEETIFY_API_KEY;
    await setGuildModule(GID, 'economy', { enabled: true, config: {} });
    await setGuildModule(GID, 'markets', { enabled: true, config: {} });
    const call = (path, body) =>
      fetch(`${app.base}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    const bad = await call(`/guilds/${GID}/markets/create-cs2`, { steamId: 'abc' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /SteamID64/);
    const ok = await call(`/guilds/${GID}/markets/create-cs2`, {
      steamId: 'https://steamcommunity.com/profiles/76561198000000001',
      name: 'Krip',
      closesAt: Date.now() + 3_600_000,
    });
    assert.equal(ok.status, 200);
    const overview = await (await call(`/api/v2/guilds/${GID}/modules/markets/overview`)).json();
    const market = overview.markets.find((m) => m.source === 'cs2');
    assert.equal(market.question, 'Czy Krip wygra następny mecz CS2?');
    assert.equal(overview.leetify, false);
  } finally {
    app.close();
  }
});
