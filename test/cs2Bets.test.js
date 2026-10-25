import './helpers/dashboardUrl.js';
import { startWebApp } from './helpers/webApp.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { credit, getAccount } from '../src/db/economy.js';
import {
  saveSteamLink,
  getSteamLink,
  removeSteamLink,
  insertCs2Bet,
  pendingCs2BetOf,
  recentCs2Bets,
} from '../src/db/cs2.js';
import { forgetUser } from '../src/db/purge.js';
import {
  signSteamToken,
  verifySteamToken,
  steamLoginUrl,
  returnUrl,
  verifySteamAssertion,
  STEAM_OPENID,
} from '../src/modules/lib/steamLink.js';
import {
  placeCs2Bet,
  syncCs2Bets,
  claimCs2ByLink,
  debugCs2,
  MIN_MATCH_GAP_MS,
} from '../src/modules/cs2Bets.js';

const U1 = '700000000000000081';
const U2 = '700000000000000082';
const STEAM1 = '76561198000000011';
const STEAM2 = '76561198000000012';
const BASE = 'https://panel.example';

const assertion = (token, steamId, over = {}) => ({
  'openid.ns': 'http://specs.openid.net/auth/2.0',
  'openid.mode': 'id_res',
  'openid.op_endpoint': STEAM_OPENID,
  'openid.claimed_id': `https://steamcommunity.com/openid/id/${steamId}`,
  'openid.identity': `https://steamcommunity.com/openid/id/${steamId}`,
  'openid.return_to': returnUrl(BASE, token),
  'openid.response_nonce': '2026-10-25T10:00:00Zabc',
  'openid.signed': 'signed,op_endpoint,claimed_id',
  'openid.sig': 'sig',
  ...over,
});

const fakeSteam = (text = 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n', ok = true) => {
  const calls = [];
  return {
    calls,
    fn: async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return { ok, text: async () => text };
    },
  };
};

test('steam tokens are signed, expire and name the member', () => {
  const t = signSteamToken(GID, U1, 1000);
  assert.deepEqual(verifySteamToken(t, 2000), { guildId: GID, userId: U1 });
  assert.equal(verifySteamToken(t, 1000 + 11 * 60_000), null, 'expired');
  assert.equal(verifySteamToken(t.slice(0, -2) + 'xx', 2000), null, 'tampered');
  assert.equal(verifySteamToken('garbage'), null);
  assert.match(steamLoginUrl(BASE, t), /^https:\/\/steamcommunity\.com\/openid\/login\?/);
});

test('verifySteamAssertion accepts only Steam-confirmed, matching assertions', async () => {
  const token = signSteamToken(GID, U1);
  const ok = fakeSteam();
  assert.equal(await verifySteamAssertion(assertion(token, STEAM1), returnUrl(BASE, token), ok.fn), STEAM1);
  assert.match(ok.calls[0].body, /openid.mode=check_authentication/);

  const bad = fakeSteam('is_valid:false\n');
  assert.equal(await verifySteamAssertion(assertion(token, STEAM1), returnUrl(BASE, token), bad.fn), null);
  const wrongReturn = fakeSteam();
  assert.equal(
    await verifySteamAssertion(
      assertion(token, STEAM1, { 'openid.return_to': 'https://evil.example/' }),
      returnUrl(BASE, token),
      wrongReturn.fn
    ),
    null
  );
  assert.equal(wrongReturn.calls.length, 0, 'never even asks Steam about a mismatched return_to');
  assert.equal(
    await verifySteamAssertion(
      assertion(token, STEAM1, { 'openid.claimed_id': 'https://evil.example/id/' + STEAM1 }),
      returnUrl(BASE, token),
      fakeSteam().fn
    ),
    null
  );
  assert.equal(
    await verifySteamAssertion(
      assertion(token, STEAM1, { 'openid.op_endpoint': 'https://evil.example/login' }),
      returnUrl(BASE, token),
      fakeSteam().fn
    ),
    null
  );
  assert.equal(
    await verifySteamAssertion(
      assertion(token, STEAM1, { 'openid.mode': 'cancel' }),
      returnUrl(BASE, token),
      fakeSteam().fn
    ),
    null
  );
});

test('a Steam account links to one member per guild', async () => {
  assert.equal(await saveSteamLink(GID, U1, STEAM1), 'ok');
  assert.equal(await saveSteamLink(GID, U1, STEAM1), 'ok', 'relinking yourself is fine');
  assert.equal(await saveSteamLink(GID, U2, STEAM1), 'taken');
  assert.equal(await saveSteamLink('800000000000000099', U2, STEAM1), 'ok', 'other guilds are independent');
  assert.equal(await getSteamLink(GID, U1), STEAM1);
  assert.equal(await saveSteamLink(GID, U1, STEAM2), 'ok', 'switching account');
  assert.equal(await removeSteamLink(GID, U1), true);
  assert.equal(await getSteamLink(GID, U1), null);
});

test('steam link pages: start redirects to Steam, callback stores the verified account', async () => {
  const app = await startWebApp();
  const realFetch = globalThis.fetch;
  try {
    const originalFetch = realFetch;
    const get = (path) => originalFetch(`${app.base}${path}`, { redirect: 'manual' });
    const token = signSteamToken(GID, U2);

    assert.equal((await get('/steam/start?t=bad')).status, 400);
    const start = await get(`/steam/start?t=${encodeURIComponent(token)}`);
    assert.equal(start.status, 302);
    assert.match(start.headers.get('location'), /^https:\/\/steamcommunity\.com\/openid\/login\?/);

    const query = new URLSearchParams({
      ...assertion(token, STEAM2, { 'openid.return_to': returnUrl(BASE, token) }),
      t: token,
    });
    // Steam confirms the assertion only when the bot asks Steam; local requests go through.
    globalThis.fetch = async (url, init) =>
      String(url).startsWith(STEAM_OPENID)
        ? { ok: true, text: async () => 'is_valid:true\n' }
        : originalFetch(url, init);
    const done = await originalFetch(`${app.base}/steam/callback?${query}`);
    assert.equal(done.status, 200);
    assert.match(await done.text(), /Steam połączony/);
    assert.equal(await getSteamLink(GID, U2), STEAM2);

    globalThis.fetch = async (url, init) =>
      String(url).startsWith(STEAM_OPENID)
        ? { ok: true, text: async () => 'is_valid:false\n' }
        : originalFetch(url, init);
    const rejected = await originalFetch(`${app.base}/steam/callback?${query}`);
    assert.equal(rejected.status, 400);
  } finally {
    globalThis.fetch = realFetch;
    app.close();
  }
});

// ------------------------------------------------------------------- bets ----

const GUILD = '800000000000000051';
const match = (id, finishedAt, steamId, mine, theirs, mode = 'wingman') => ({
  id,
  game_mode: mode,
  finished_at: new Date(finishedAt).toISOString(),
  map_name: 'de_mirage',
  team_scores: [
    { team_number: 2, score: mine },
    { team_number: 3, score: theirs },
  ],
  stats: [{ steam64_id: steamId, initial_team_number: 2 }],
});

async function setup(guild = GUILD) {
  await setGuildModule(guild, 'economy', {
    enabled: true,
    config: { startingBalance: 0, games: { enabled: true, minBet: 10, maxBet: 5000 } },
  });
  process.env.LEETIFY_API_KEY = 'k';
}

test('placeCs2Bet needs Leetify, a linked Steam, limits and funds', async () => {
  await setup();
  delete process.env.LEETIFY_API_KEY;
  await credit(GUILD, U1, 1000);
  assert.match((await placeCs2Bet(GUILD, U1, 100, 'wingman')).error, /Leetify/);
  process.env.LEETIFY_API_KEY = 'k';
  assert.match((await placeCs2Bet(GUILD, U1, 100, 'wingman')).error, /\/steam polacz/);
  await saveSteamLink(GUILD, U1, STEAM1);
  assert.match((await placeCs2Bet(GUILD, U1, 5, 'wingman')).error, /od 10 do 5000/);
  assert.match((await placeCs2Bet(GUILD, U2, 100, 'wingman')).error, /\/steam polacz/);
  await saveSteamLink(GUILD, U2, STEAM2);
  assert.match((await placeCs2Bet(GUILD, U2, 100, 'wingman')).error, /Nie masz tylu monet/);

  const ok = await placeCs2Bet(GUILD, U1, 200, 'wingman');
  assert.equal(ok.ok, true);
  assert.equal(ok.balance, 800);
  assert.match((await placeCs2Bet(GUILD, U1, 100, 'wingman')).error, /aktywną stawkę/);
  assert.equal((await getAccount(GUILD, U1)).balance, 800, 'a refused second stake costs nothing');
  assert.equal((await pendingCs2BetOf(GUILD, U1)).amount, 200);
  delete process.env.LEETIFY_API_KEY;
});

test('two simultaneous stakes: exactly one is accepted and the other is refunded', async () => {
  const guild = '800000000000000052';
  await setup(guild);
  await credit(guild, U1, 1000);
  await saveSteamLink(guild, U1, STEAM1);
  const results = await Promise.all([
    placeCs2Bet(guild, U1, 100, 'wingman'),
    placeCs2Bet(guild, U1, 100, 'wingman'),
    placeCs2Bet(guild, U1, 100, 'wingman'),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await getAccount(guild, U1)).balance, 900);
  delete process.env.LEETIFY_API_KEY;
});

test('syncCs2Bets pays 2x on a win, nothing on a loss, refunds ties and skips too-close matches', async () => {
  const guild = '800000000000000053';
  await setup(guild);
  for (const u of [U1, U2]) await credit(guild, u, 1000);
  await saveSteamLink(guild, U1, STEAM1);
  await saveSteamLink(guild, U2, STEAM2);
  await placeCs2Bet(guild, U1, 100, 'wingman');
  await placeCs2Bet(guild, U2, 100, 'wingman');
  const placed = (await pendingCs2BetOf(guild, U1)).createdAt;

  const realFetch = globalThis.fetch;
  let table = {};
  globalThis.fetch = async (url) => {
    const id = new URL(String(url)).searchParams.get('steamId');
    return { ok: true, status: 200, json: async () => ({ matches: table[id] ?? [] }) };
  };
  try {
    await syncCs2Bets();
    assert.equal((await pendingCs2BetOf(guild, U1)).amount, 100, 'no match yet');

    // Finishes only 10 min after the stake: already in progress when it was placed — ignored.
    table = { [STEAM1]: [match('close', placed + 10 * 60_000, STEAM1, 13, 0)] };
    await syncCs2Bets();
    assert.ok(await pendingCs2BetOf(guild, U1), 'a match ending too soon does not count');

    table = {
      [STEAM1]: [match('w', placed + MIN_MATCH_GAP_MS + 60_000, STEAM1, 13, 7)],
      [STEAM2]: [match('l', placed + MIN_MATCH_GAP_MS + 60_000, STEAM2, 5, 13)],
    };
    await syncCs2Bets();
    assert.equal(await pendingCs2BetOf(guild, U1), null);
    assert.equal((await getAccount(guild, U1)).balance, 1100, 'won: 900 + 200');
    assert.equal((await getAccount(guild, U2)).balance, 900, 'lost: stake gone');
    assert.deepEqual(
      (await recentCs2Bets(guild, U1, 1)).map((b) => [b.status, b.payout]),
      [['won', 200]]
    );

    await syncCs2Bets();
    assert.equal((await getAccount(guild, U1)).balance, 1100, 'settled stakes are never paid twice');

    await placeCs2Bet(guild, U1, 50, 'wingman');
    const at = (await pendingCs2BetOf(guild, U1)).createdAt;
    table = { [STEAM1]: [match('t', at + MIN_MATCH_GAP_MS + 60_000, STEAM1, 15, 15)] };
    await syncCs2Bets();
    assert.equal((await getAccount(guild, U1)).balance, 1100, 'tie: stake returned');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LEETIFY_API_KEY;
  }
});

test('stakes with no usable match are refunded after three days', async () => {
  const guild = '800000000000000054';
  await setup(guild);
  await credit(guild, U1, 500);
  await saveSteamLink(guild, U1, STEAM1);
  await placeCs2Bet(guild, U1, 100, 'wingman');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ matches: [] }) });
  try {
    await syncCs2Bets(Date.now() + 73 * 3_600_000);
    assert.equal((await getAccount(guild, U1)).balance, 500);
    assert.equal((await recentCs2Bets(guild, U1, 1))[0].status, 'expired');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LEETIFY_API_KEY;
  }
});

test('/forget removes the link and finished stakes but keeps a pending stake', async () => {
  const guild = '800000000000000055';
  await saveSteamLink(guild, U1, STEAM1);
  const id = await insertCs2Bet(guild, U1, STEAM1, 10, 'wingman');
  assert.ok(id);
  await forgetUser(guild, U1);
  assert.equal(await getSteamLink(guild, U1), null);
  assert.ok(await pendingCs2BetOf(guild, U1), 'owed coins are not forgotten');
});

test('each mode pays its own multiplier and only counts matches of that mode', async () => {
  const guild = '800000000000000056';
  await setup(guild);
  const users = { rush: U1, competitive: U2, premier: '300000000000000003' };
  const steams = { rush: STEAM1, competitive: STEAM2, premier: '76561198000000003' };
  for (const [mode, user] of Object.entries(users)) {
    await credit(guild, user, 1000);
    await saveSteamLink(guild, user, steams[mode]);
    await placeCs2Bet(guild, user, 100, mode);
  }
  assert.match((await placeCs2Bet(guild, U1, 100, 'bogus')).error, /tryb/);
  const placed = (await pendingCs2BetOf(guild, U1)).createdAt;
  const at = placed + MIN_MATCH_GAP_MS + 60_000;

  const realFetch = globalThis.fetch;
  let table = {};
  globalThis.fetch = async (url) => {
    const id = new URL(String(url)).searchParams.get('steamId');
    return { ok: true, status: 200, json: async () => ({ matches: table[id] ?? [] }) };
  };
  try {
    // A win in the wrong mode, or in a mode Leetify doesn't name, settles nothing.
    table = {
      [steams.rush]: [match('x', at, steams.rush, 13, 5, 'wingman')],
      [steams.competitive]: [
        { ...match('y', at, steams.competitive, 13, 5), game_mode: undefined, data_source: 'matchmaking' },
      ],
      [steams.premier]: [match('p', at, steams.premier, 13, 5, 'premier')],
    };
    await syncCs2Bets();
    assert.ok(await pendingCs2BetOf(guild, users.rush));
    assert.ok(await pendingCs2BetOf(guild, users.competitive));
    assert.equal(await pendingCs2BetOf(guild, users.premier), null);
    assert.equal((await getAccount(guild, users.premier)).balance, 1200, '900 + 100 x3');

    table = {
      [steams.rush]: [match('r', at, steams.rush, 13, 5, 'rush')],
      [steams.competitive]: [match('c', at, steams.competitive, 13, 5, 'competitive')],
    };
    await syncCs2Bets();
    assert.equal((await getAccount(guild, users.rush)).balance, 1050, '900 + 100 x1.5');
    assert.equal((await getAccount(guild, users.competitive)).balance, 1150, '900 + 100 x2.5');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LEETIFY_API_KEY;
  }
});

test('claimCs2ByLink settles from a Leetify link, with all the checks', async () => {
  const guild = '800000000000000057';
  await setup(guild);
  await credit(guild, U1, 1000);
  await saveSteamLink(guild, U1, STEAM1);
  assert.match(
    (
      await claimCs2ByLink(
        guild,
        U1,
        'https://leetify.com/app/match-details/f2f225b7-2df0-4452-8cdb-a35ea61dc7b6/your-match'
      )
    ).message,
    /aktywnej stawki/
  );
  await placeCs2Bet(guild, U1, 100, 'rush');
  const placed = (await pendingCs2BetOf(guild, U1)).createdAt;
  const at = placed + MIN_MATCH_GAP_MS + 60_000;
  const A = 'f2f225b7-2df0-4452-8cdb-a35ea61dc7b6';
  const B = 'a2f225b7-2df0-4452-8cdb-a35ea61dc7b6';
  const link = (id) => `[7 : 3 on Complex](https://leetify.com/app/match-details/${id}/your-match)`;

  const realFetch = globalThis.fetch;
  let list = [];
  let byId = {};
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.startsWith('/v3/matches/'))
      return {
        ok: !!byId[u.pathname.split('/').pop()],
        status: byId[u.pathname.split('/').pop()] ? 200 : 404,
        json: async () => byId[u.pathname.split('/').pop()],
      };
    return { ok: true, status: 200, json: async () => ({ matches: list }) };
  };
  try {
    assert.match((await claimCs2ByLink(guild, U1, 'nope')).message, /link/);
    assert.match((await claimCs2ByLink(guild, U1, link(A))).message, /nie zna/);

    // Someone else's match: not in the player's list, and the player isn't in it.
    byId = { [A]: match(A, at, STEAM2, 13, 3, 'rush') };
    assert.match((await claimCs2ByLink(guild, U1, link(A))).message, /nie widzę/i);

    byId = { [A]: { ...match(A, placed + 5 * 60_000, STEAM1, 13, 3, 'rush') } };
    assert.match((await claimCs2ByLink(guild, U1, link(A))).message, /co najmniej 25 min/);

    byId = { [A]: match(A, at, STEAM1, 13, 3, 'premier') };
    assert.match((await claimCs2ByLink(guild, U1, link(A))).message, /Premier.*Rush/);

    // An earlier counting match in the player's own history blocks cherry-picking.
    list = [match(B, at - 30_000, STEAM1, 3, 13, 'rush')];
    byId = { [A]: match(A, at, STEAM1, 13, 3, 'rush') };
    assert.match((await claimCs2ByLink(guild, U1, link(A))).message, /pierwszy mecz/);

    list = [];
    const done = await claimCs2ByLink(guild, U1, link(A));
    assert.equal(done.ok, true);
    assert.equal((await getAccount(guild, U1)).balance, 1050, '900 + 100 x1.5');
    assert.match((await claimCs2ByLink(guild, U1, link(A))).message, /aktywnej stawki/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LEETIFY_API_KEY;
  }
});

test('debugCs2 lists recent matches and how the bot reads them', async () => {
  const guild = '800000000000000058';
  await setup(guild);
  await saveSteamLink(guild, U1, STEAM1);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ matches: [match('m1', Date.now(), STEAM1, 13, 7, 'rush')] }),
  });
  try {
    const text = await debugCs2(guild, U1);
    assert.match(text, /de_mirage/);
    assert.match(text, /13:7/);
    assert.match(text, /tryb: rush/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LEETIFY_API_KEY;
  }
});
