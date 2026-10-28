import { startWebApp } from './helpers/webApp.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { ensureAccount, getAccount } from '../src/db/economy.js';
import {
  insertCs2Bet,
  refundCs2Bet,
  settleCs2Bet,
  activeGuildCs2Bets,
  recentCs2Bets,
} from '../src/db/cs2.js';

test('refund closes only active guild bets and credits the bettor exactly once', async () => {
  const user = 'refund-bettor';
  await ensureAccount(GID, user, 100);
  const id = await insertCs2Bet(GID, user, 'steam', 50, 'premier', '', { targetId: 'other-player' });
  assert.equal(await refundCs2Bet('other-guild', id), false);
  const results = await Promise.all([refundCs2Bet(GID, id), refundCs2Bet(GID, id)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal((await getAccount(GID, user)).balance, 150);
  assert.equal((await getAccount(GID, 'other-player')).balance, 0);
  assert.equal(await settleCs2Bet(id, 'won', 150), false);
  assert.equal((await recentCs2Bets(GID, user))[0].status, 'refunded');
  assert.equal(
    (await activeGuildCs2Bets(GID)).some((bet) => bet.id === id),
    false
  );
  assert.equal(await refundCs2Bet(GID, NaN), false);
});

test('a settled result wins over a subsequent refund', async () => {
  const id = await insertCs2Bet(GID, 'already-won', 'steam', 30);
  assert.equal(await settleCs2Bet(id, 'won', 90), true);
  assert.equal(await refundCs2Bet(GID, id), false);
  assert.equal((await getAccount(GID, 'already-won')).balance, 0);
});

test('failed credit rolls back the pending bet closure', async () => {
  const id = await insertCs2Bet(GID, 'failed-credit', 'steam', 20);
  db.exec(
    "CREATE TRIGGER fail_refund_credit BEFORE INSERT ON economy_accounts WHEN NEW.user_id = 'failed-credit' BEGIN SELECT RAISE(ABORT, 'credit failed'); END"
  );
  try {
    await assert.rejects(refundCs2Bet(GID, id), /credit failed/);
  } finally {
    db.exec('DROP TRIGGER fail_refund_credit');
  }
  assert.equal((await recentCs2Bets(GID, 'failed-credit'))[0].status, 'pending');
  assert.equal(await refundCs2Bet(GID, id), true);
  assert.equal((await getAccount(GID, 'failed-credit')).balance, 20);
});

test('classic page lists active bets and refund POST returns stake once', async () => {
  const id = await insertCs2Bet(GID, 'route-refund', 'steam', 70);
  const foreign = await insertCs2Bet('foreign', 'foreign-user', 'steam', 99);
  const app = await startWebApp();
  try {
    const html = await (await fetch(`${app.base}/guilds/${GID}/cs2`)).text();
    assert.ok(html.includes('Aktywne mecze / zakłady CS2'));
    assert.ok(html.includes(`/cs2/${id}/refund`));
    assert.ok(!html.includes(`/cs2/${foreign}/refund`));
    const refund = (betId) =>
      fetch(`${app.base}/guilds/${GID}/cs2/${betId}/refund`, { method: 'POST', redirect: 'manual' });
    assert.equal((await refund(id)).headers.get('location'), `/guilds/${GID}/cs2?msg=refunded`);
    assert.equal((await refund(id)).headers.get('location'), `/guilds/${GID}/cs2?msg=already-settled`);
    assert.equal((await getAccount(GID, 'route-refund')).balance, 70);
    await refund(foreign);
    assert.equal((await getAccount('foreign', 'foreign-user')).balance, 0);
  } finally {
    app.close();
  }
});
