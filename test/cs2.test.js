import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { credit, getAccount } from '../src/db/economy.js';
import { getMarket } from '../src/db/markets.js';
import {
  parseSteam64,
  evaluateCs2Match,
  firstMatchAfter,
  matchList,
  detectMode,
} from '../src/modules/lib/cs2.js';
import { createCs2Market, placeBet, syncCs2 } from '../src/modules/markets.js';

const STEAM = '76561198000000001';
const OTHER = '76561198000000002';
const GUILD = '800000000000000041';
const A = '700000000000000071';
const B = '700000000000000072';

const match = (over = {}) => ({
  id: 'm1',
  finished_at: '2026-10-23T20:00:00Z',
  map_name: 'de_mirage',
  team_scores: [
    { team_number: 2, score: 13 },
    { team_number: 3, score: 9 },
  ],
  stats: [
    { steam64_id: STEAM, initial_team_number: 2 },
    { steam64_id: OTHER, initial_team_number: 3 },
  ],
  ...over,
});

test('parseSteam64 accepts ids and profile links only', () => {
  assert.equal(parseSteam64(STEAM), STEAM);
  assert.equal(parseSteam64(`https://steamcommunity.com/profiles/${STEAM}/`), STEAM);
  assert.equal(parseSteam64(`https://leetify.com/app/profile/${STEAM}`), STEAM);
  assert.equal(parseSteam64('https://steamcommunity.com/id/vanity'), null);
  assert.equal(parseSteam64('https://evil.example/profiles/' + STEAM), null);
  assert.equal(parseSteam64('123'), null);
});

test('evaluateCs2Match: win, loss, tie and unclear', () => {
  assert.deepEqual(evaluateCs2Match(match(), STEAM), { state: 'win', map: 'de_mirage', score: '13:9' });
  assert.equal(evaluateCs2Match(match(), OTHER).state, 'loss');
  const tie = match({
    team_scores: [
      { team_number: 2, score: 15 },
      { team_number: 3, score: 15 },
    ],
  });
  assert.equal(evaluateCs2Match(tie, STEAM).state, 'tie');
  assert.equal(
    evaluateCs2Match(match({ stats: [] }), STEAM).state,
    'unclear',
    'player missing from the match'
  );
  assert.equal(evaluateCs2Match(match({ team_scores: [] }), STEAM).state, 'unclear');
  const withOutcome = match({ team_scores: [], stats: [{ steam64_id: STEAM, outcome: 'win' }] });
  assert.equal(evaluateCs2Match(withOutcome, STEAM).state, 'win', 'falls back to the reported outcome');
  const disagree = match({ stats: [{ steam64_id: STEAM, initial_team_number: 2, outcome: 'loss' }] });
  assert.equal(evaluateCs2Match(disagree, STEAM).state, 'unclear', 'conflicting data is never guessed');
});

test('firstMatchAfter picks the oldest match finished after the cut-off', () => {
  const early = match({ id: 'early', finished_at: '2026-10-23T18:00:00Z' });
  const next = match({ id: 'next', finished_at: '2026-10-23T20:30:00Z' });
  const later = match({ id: 'later', finished_at: '2026-10-23T22:00:00Z' });
  const cutoff = Date.parse('2026-10-23T19:00:00Z');
  assert.equal(firstMatchAfter([later, next, early], STEAM, cutoff).id, 'next');
  assert.equal(firstMatchAfter([early], STEAM, cutoff), null);
  assert.equal(matchList({ matches: [early] }).length, 1);
  assert.equal(matchList([early]).length, 1);
});

test('CS2 market settles itself from Leetify and refunds ties', async () => {
  await setGuildModule(GUILD, 'economy', { enabled: true, config: { startingBalance: 0 } });
  await setGuildModule(GUILD, 'markets', { enabled: true, config: { minBet: 10, maxBet: 500 } });
  process.env.LEETIFY_API_KEY = 'test-key';
  const realFetch = globalThis.fetch;
  let matches = [];
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.authorization });
    return { ok: true, status: 200, json: async () => ({ matches }) };
  };
  try {
    await assert.rejects(createCs2Market(GUILD, { steamId: 'nope' }), /SteamID64/);
    const id = await createCs2Market(GUILD, { steamId: STEAM, name: 'Krip' });
    const market = await getMarket(id);
    assert.equal(market.source, 'cs2');
    assert.equal(market.question, 'Czy Krip wygra następny mecz CS2?');
    assert.deepEqual(
      market.options.map((o) => o.label),
      ['Wygra', 'Przegra']
    );
    assert.match(seen[0].url, /api-public\.cs-prod\.leetify\.com\/v3\/profile\/matches\?steamId=7656/);
    assert.equal(seen[0].auth, 'Bearer test-key');

    await credit(GUILD, A, 300);
    await credit(GUILD, B, 300);
    await placeBet(GUILD, A, id, 0, 100);
    await placeBet(GUILD, B, id, 1, 100);

    await syncCs2();
    assert.equal((await getMarket(id)).status, 'open', 'no match yet');

    matches = [match({ id: 'old', finished_at: new Date(market.createdAt - 60_000).toISOString() })];
    await syncCs2();
    assert.equal((await getMarket(id)).status, 'open', 'a match finished before the market does not count');

    matches = [...matches, match({ id: 'new', finished_at: new Date(Date.now() + 1000).toISOString() })];
    await syncCs2();
    const settled = await getMarket(id);
    assert.equal(settled.status, 'resolved');
    assert.equal(settled.winner, 0);
    assert.equal((await getAccount(GUILD, A)).balance, 400);
    assert.equal((await getAccount(GUILD, B)).balance, 200);

    // A tie refunds everyone.
    const tieId = await createCs2Market(GUILD, { steamId: STEAM, name: 'Krip' });
    await placeBet(GUILD, A, tieId, 0, 50);
    matches = [
      match({
        id: 'tie',
        finished_at: new Date(Date.now() + 5000).toISOString(),
        team_scores: [
          { team_number: 2, score: 15 },
          { team_number: 3, score: 15 },
        ],
      }),
    ];
    const before = (await getAccount(GUILD, A)).balance;
    await syncCs2();
    assert.equal((await getMarket(tieId)).status, 'cancelled');
    assert.equal((await getAccount(GUILD, A)).balance, before + 50);

    // Unclear data leaves the market open for a manual decision.
    const unclearId = await createCs2Market(GUILD, { steamId: STEAM, name: 'Krip' });
    matches = [match({ id: 'u', finished_at: new Date(Date.now() + 9000).toISOString(), stats: [] })];
    await syncCs2();
    assert.equal((await getMarket(unclearId)).status, 'open');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LEETIFY_API_KEY;
  }
});

test('syncCs2 does nothing without a Leetify key', async () => {
  delete process.env.LEETIFY_API_KEY;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('must not be called');
  };
  try {
    await syncCs2();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('detectMode only recognises a mode by its own name', () => {
  assert.equal(detectMode({ game_mode: 'Wingman' }), 'wingman');
  assert.equal(detectMode({ data_source: 'matchmaking_premier' }), 'premier');
  assert.equal(detectMode({ data_source: 'matchmaking' }), null);
  assert.equal(
    detectMode({ data_source: 'premier', game_mode: 'wingman' }),
    null,
    'conflicting hints are unknown'
  );
  assert.equal(detectMode({}), null);
});
