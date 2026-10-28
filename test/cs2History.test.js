import './helpers/dashboardUrl.js';
import { startWebApp } from './helpers/webApp.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { insertCs2Bet, settleCs2Bet, cs2BetHistory } from '../src/db/cs2.js';

test('CS2 history is guild scoped, newest first and paginated', async () => {
  const first = await insertCs2Bet(GID, 'history-user-1', 'steam-1', 100);
  await settleCs2Bet(first, 'won', 200);
  const second = await insertCs2Bet(GID, 'history-user-2', 'steam-2', 50);
  await insertCs2Bet('other-guild', 'history-user-3', 'steam-3', 99);
  assert.deepEqual(
    (await cs2BetHistory(GID, 1, 0)).map((b) => b.id),
    [second]
  );
  const older = await cs2BetHistory(GID, 1, 1);
  assert.equal(older[0].id, first);
  assert.equal(older[0].payout, 200);
  const app = await startWebApp();
  try {
    const response = await fetch(`${app.base}/api/v2/guilds/${GID}/cs2`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.bets.map((b) => b.id),
      [second, first]
    );
    assert.equal(body.hasMore, false);
    await setGuildModule(GID, 'economy', { config: { startingBalance: 777, games: { enabled: true } } });
    const saved = await fetch(`${app.base}/api/v2/guilds/${GID}/cs2/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ping: false, winMessage: 'Wygrana {user}' }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).config.winMessage, 'Wygrana {user}');
    const { config } = await getGuildModule(GID, 'economy');
    assert.equal(config.startingBalance, 777);
    assert.equal(config.games.enabled, true);
    assert.equal(config.games.cs2.ping, false);
    const classic = await fetch(`${app.base}/guilds/${GID}/cs2`);
    assert.equal(classic.status, 200);
    const html = await classic.text();
    assert.ok(html.includes('Historia zakładów CS2'));
    assert.ok(html.includes('history-user-1'));
    assert.ok(html.includes(`/guilds/${GID}/cs2/config`));
    const classicSave = await fetch(`${app.base}/guilds/${GID}/cs2/config`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ cs2_win: 'V1 {user}', cs2_ping: 'on' }),
    });
    assert.equal(classicSave.status, 302);
    const updated = await getGuildModule(GID, 'economy');
    assert.equal(updated.config.games.cs2.winMessage, 'V1 {user}');
    assert.equal(updated.config.games.cs2.ping, true);
    assert.equal(updated.config.startingBalance, 777);
    const overviewResponse = await fetch(`${app.base}/guilds/${GID}/overview`);
    assert.equal(overviewResponse.status, 200);
    assert.ok((await overviewResponse.text()).includes(`/guilds/${GID}/cs2`));
  } finally {
    app.close();
  }
});
