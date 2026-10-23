import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { credit, getAccount } from '../src/db/economy.js';
import { getMarket, betsOfMarket, optionPools, topPredictors, userBets } from '../src/db/markets.js';
import {
  computePayouts,
  describePools,
  normaliseMarketInput,
  parsePolymarketSlug,
  evaluatePolymarketEvent,
} from '../src/modules/lib/marketMath.js';
import {
  normaliseMarkets,
  createCustomMarket,
  placeBet,
  settleMarket,
  cancelMarket,
  fetchPolymarketEvent,
  importPolymarket,
  syncPolymarket,
  marketsOverview,
} from '../src/modules/markets.js';

const GUILD = '800000000000000021';
const A = '700000000000000031';
const B = '700000000000000032';
const C = '700000000000000033';

const enable = async (guild, marketsConfig = { minBet: 10, maxBet: 500 }) => {
  await setGuildModule(guild, 'economy', { enabled: true, config: { startingBalance: 0 } });
  await setGuildModule(guild, 'markets', { enabled: true, config: marketsConfig });
};
const twoWay = (extra = {}) => ({ question: 'Czy Polska wygra?', options: ['Tak', 'Nie'], ...extra });

// ------------------------------------------------------------------ maths ----

test('computePayouts splits the whole pool between winners by stake', () => {
  const bets = [
    { id: 1, optionIdx: 0, amount: 100 },
    { id: 2, optionIdx: 0, amount: 300 },
    { id: 3, optionIdx: 1, amount: 600 },
  ];
  const out = computePayouts(bets, 0);
  assert.deepEqual(out, [
    { id: 1, payout: 250 },
    { id: 2, payout: 750 },
    { id: 3, payout: 0 },
  ]);
  const paid = out.reduce((s, p) => s + p.payout, 0);
  assert.ok(paid <= 1000, 'never pays out more than was staked');
});

test('computePayouts rounds down and never creates coins', () => {
  const bets = [
    { id: 1, optionIdx: 0, amount: 1 },
    { id: 2, optionIdx: 0, amount: 1 },
    { id: 3, optionIdx: 0, amount: 1 },
    { id: 4, optionIdx: 1, amount: 1 },
  ];
  const paid = computePayouts(bets, 0).reduce((s, p) => s + p.payout, 0);
  assert.equal(paid, 3);
});

test('computePayouts refunds everyone when nobody backed the winner', () => {
  const bets = [
    { id: 1, optionIdx: 0, amount: 40 },
    { id: 2, optionIdx: 1, amount: 60 },
  ];
  assert.deepEqual(computePayouts(bets, 2), [
    { id: 1, payout: 40 },
    { id: 2, payout: 60 },
  ]);
});

test('computePayouts stays exact beyond 2^53', () => {
  const big = 900_000_000_000;
  const bets = [
    { id: 1, optionIdx: 0, amount: big },
    { id: 2, optionIdx: 1, amount: big },
  ];
  assert.deepEqual(computePayouts(bets, 0), [
    { id: 1, payout: 2 * big },
    { id: 2, payout: 0 },
  ]);
});

test('describePools gives shares and multipliers', () => {
  const d = describePools([
    { total: 100, bets: 1 },
    { total: 300, bets: 2 },
    { total: 0, bets: 0 },
  ]);
  assert.equal(d.total, 400);
  assert.equal(d.options[0].share, 0.25);
  assert.equal(d.options[0].multiplier, 4);
  assert.equal(d.options[2].multiplier, null);
});

test('normaliseMarketInput validates question, options and deadline', () => {
  assert.equal(normaliseMarketInput({ question: 'x', options: 'a\nb' }).ok, false);
  assert.equal(normaliseMarketInput({ question: 'Pytanie?', options: 'tylko jedna' }).ok, false);
  assert.equal(normaliseMarketInput({ question: 'Pytanie?', options: 'a\nA\nb' }).value.options.length, 2);
  assert.equal(
    normaliseMarketInput({ question: 'Pytanie?', options: Array.from({ length: 11 }, (_, i) => `o${i}`) }).ok,
    false
  );
  assert.equal(
    normaliseMarketInput({ question: 'Pytanie?', options: 'a\nb', closesAt: 'nonsense' }).ok,
    false
  );
  const ok = normaliseMarketInput({
    question: ' Pytanie? ',
    options: ' a \n b ',
    closesAt: '2030-01-01T10:00',
  });
  assert.equal(ok.value.question, 'Pytanie?');
  assert.ok(ok.value.closesAt > 0);
  assert.equal(normaliseMarketInput({ question: 'Pytanie?', options: 'a\nb' }).value.closesAt, 0);
});

test('normaliseMarkets clamps bet limits', () => {
  assert.deepEqual(normaliseMarkets({ minBet: 50, maxBet: 10 }), { minBet: 50, maxBet: 50, channelId: '' });
  assert.equal(normaliseMarkets({}).minBet, 10);
});

// ------------------------------------------------------------- polymarket ----

test('parsePolymarketSlug accepts urls and bare slugs only from polymarket', () => {
  assert.equal(parsePolymarketSlug('https://polymarket.com/event/some-slug-2026?tid=1'), 'some-slug-2026');
  assert.equal(parsePolymarketSlug('https://polymarket.com/market/other'), 'other');
  assert.equal(parsePolymarketSlug('plain-slug'), 'plain-slug');
  assert.equal(parsePolymarketSlug('https://evil.example/event/x'), null);
  assert.equal(parsePolymarketSlug('http://169.254.169.254/'), null);
  assert.equal(parsePolymarketSlug(''), null);
});

const gammaMarket = (over = {}) => ({
  question: 'Will it happen?',
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.62","0.38"]',
  closed: false,
  ...over,
});

test('evaluatePolymarketEvent: single open market keeps prices', () => {
  const e = evaluatePolymarketEvent({
    title: 'Q',
    endDate: '2031-01-01T00:00:00Z',
    markets: [gammaMarket()],
  });
  assert.equal(e.state, 'open');
  assert.deepEqual(
    e.options.map((o) => [o.label, o.price]),
    [
      ['Yes', 0.62],
      ['No', 0.38],
    ]
  );
  assert.ok(e.closesAt > 0);
});

test('evaluatePolymarketEvent: resolved, void and unclear results', () => {
  const resolved = evaluatePolymarketEvent({
    title: 'Q',
    markets: [gammaMarket({ closed: true, umaResolutionStatus: 'resolved', outcomePrices: '["0","1"]' })],
  });
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.winner, 1);
  const voided = evaluatePolymarketEvent({
    title: 'Q',
    markets: [gammaMarket({ closed: true, umaResolutionStatus: 'resolved', outcomePrices: '["0.5","0.5"]' })],
  });
  assert.equal(voided.state, 'void');
  const disputed = evaluatePolymarketEvent({
    title: 'Q',
    markets: [gammaMarket({ closed: true, umaResolutionStatus: 'proposed', outcomePrices: '["1","0"]' })],
  });
  assert.equal(disputed.state, 'open', 'an unresolved UMA status never settles');
  const unclear = evaluatePolymarketEvent({
    title: 'Q',
    markets: [gammaMarket({ closed: true, umaResolutionStatus: 'resolved', outcomePrices: '["0.7","0.3"]' })],
  });
  assert.equal(unclear.state, 'pending');
  assert.equal(
    evaluatePolymarketEvent({
      title: 'Q',
      markets: [gammaMarket({ closed: false, outcomePrices: '["1","0"]' })],
    }).state,
    'open',
    'a 100% price on a market that is still trading is not a result'
  );
});

test('evaluatePolymarketEvent: multi-market events pick the one Yes winner', () => {
  const m = (name, yes, closed) =>
    gammaMarket({
      groupItemTitle: name,
      closed,
      umaResolutionStatus: closed ? 'resolved' : undefined,
      outcomePrices: `["${yes}","${1 - yes}"]`,
    });
  const open = evaluatePolymarketEvent({
    title: 'Who wins?',
    markets: [m('A', 0.6, false), m('B', 0.4, false)],
  });
  assert.equal(open.state, 'open');
  assert.deepEqual(
    open.options.map((o) => o.label),
    ['A', 'B']
  );
  const done = evaluatePolymarketEvent({ title: 'Who wins?', markets: [m('A', 0, true), m('B', 1, true)] });
  assert.equal(done.state, 'resolved');
  assert.equal(done.winner, 1);
  const none = evaluatePolymarketEvent({ title: 'Who wins?', markets: [m('A', 0, true), m('B', 0, true)] });
  assert.equal(none.state, 'pending');
});

test('fetchPolymarketEvent reads the Gamma API and importPolymarket stores the market', async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      json: async () => [{ slug: 'cool-market', title: 'Cool?', markets: [gammaMarket()] }],
    };
  };
  try {
    const event = await fetchPolymarketEvent('cool-market');
    assert.equal(event.question, 'Cool?');
    assert.ok(urls[0].startsWith('https://gamma-api.polymarket.com/events?slug=cool-market'));
    await enable(GUILD);
    const id = await importPolymarket(GUILD, 'https://polymarket.com/event/cool-market');
    const market = await getMarket(id);
    assert.equal(market.source, 'polymarket');
    assert.equal(market.sourceRef, 'cool-market');
    assert.equal(market.options.length, 2);
    await assert.rejects(importPolymarket(GUILD, 'cool-market'), /już otwarty/);
    await assert.rejects(importPolymarket(GUILD, 'https://evil.example/event/x'), /polymarket\.com/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('syncPolymarket settles an imported market when Polymarket has resolved it', async () => {
  const guild = '800000000000000022';
  await enable(guild);
  const realFetch = globalThis.fetch;
  let resolved = false;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [
      {
        slug: 'sync-me',
        title: 'Sync?',
        markets: [
          resolved
            ? gammaMarket({ closed: true, umaResolutionStatus: 'resolved', outcomePrices: '["1","0"]' })
            : gammaMarket({ outcomePrices: '["0.7","0.3"]' }),
        ],
      },
    ],
  });
  try {
    const id = await importPolymarket(guild, 'sync-me');
    await credit(guild, A, 200);
    await credit(guild, B, 200);
    assert.equal((await placeBet(guild, A, id, 0, 100)).ok, true);
    assert.equal((await placeBet(guild, B, id, 1, 100)).ok, true);
    await syncPolymarket();
    assert.equal((await getMarket(id)).status, 'open');
    assert.equal((await getMarket(id)).options[0].price, 0.7, 'prices follow Polymarket');
    resolved = true;
    await syncPolymarket();
    const market = await getMarket(id);
    assert.equal(market.status, 'resolved');
    assert.equal(market.winner, 0);
    assert.equal((await getAccount(guild, A)).balance, 300);
    assert.equal((await getAccount(guild, B)).balance, 100);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------------------------- bets ----

test('placeBet debits coins, records the bet and respects the limits', async () => {
  const guild = '800000000000000023';
  await enable(guild);
  const id = await createCustomMarket(guild, twoWay());
  await credit(guild, A, 1000);
  assert.match((await placeBet(guild, A, id, 0, 5)).error, /od 10 monet do 500/);
  assert.match((await placeBet(guild, A, id, 0, 501)).error, /od 10/);
  assert.match((await placeBet(guild, A, id, 0, 'abc')).error, /od 10/);
  assert.match((await placeBet(guild, A, id, 7, 50)).error, /opcji/);
  const ok = await placeBet(guild, A, id, 1, 100);
  assert.equal(ok.ok, true);
  assert.equal(ok.balance, 900);
  assert.deepEqual(
    (await optionPools(id, 2)).map((p) => p.total),
    [0, 100]
  );
  assert.match((await placeBet(guild, C, id, 0, 50)).error, /Nie masz tylu monet/);
  assert.equal((await getAccount(guild, C)).balance, 0);
});

test('placeBet refuses when the modules are off, the market is closed or the deadline passed', async () => {
  const guild = '800000000000000024';
  await enable(guild);
  const id = await createCustomMarket(guild, twoWay());
  const late = await createCustomMarket(guild, twoWay({ question: 'Za późno?', closesAt: 0 }));
  await credit(guild, A, 1000);
  await setGuildModule(guild, 'economy', { enabled: false });
  assert.match((await placeBet(guild, A, id, 0, 50)).error, /Ekonomia/);
  await setGuildModule(guild, 'economy', { enabled: true });
  await setGuildModule(guild, 'markets', { enabled: false });
  assert.match((await placeBet(guild, A, id, 0, 50)).error, /wyłączone/);
  await setGuildModule(guild, 'markets', { enabled: true });
  await settleMarket(guild, late, 0);
  assert.match((await placeBet(guild, A, late, 0, 50)).error, /zamknięty/);
  // A deadline in the past: write it straight to the row, as time passing would.
  const { db } = await import('../src/db/index.js');
  db.prepare('UPDATE markets SET closes_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  assert.match((await placeBet(guild, A, id, 0, 50)).error, /zamknięte/);
  assert.equal((await getAccount(guild, A)).balance, 1000, 'rejected bets never cost coins');
});

test('settleMarket pays winners from the whole pool and only once, even when raced', async () => {
  const guild = '800000000000000025';
  await enable(guild, { minBet: 10, maxBet: 1000 });
  const id = await createCustomMarket(guild, twoWay());
  for (const u of [A, B, C]) await credit(guild, u, 1000);
  await placeBet(guild, A, id, 0, 100);
  await placeBet(guild, B, id, 0, 300);
  await placeBet(guild, C, id, 1, 600);
  const results = await Promise.all([1, 2, 3].map(() => settleMarket(guild, id, 0)));
  assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one settlement wins the race');
  assert.equal((await getAccount(guild, A)).balance, 900 + 250);
  assert.equal((await getAccount(guild, B)).balance, 700 + 750);
  assert.equal((await getAccount(guild, C)).balance, 400);
  const total = (await Promise.all([A, B, C].map((u) => getAccount(guild, u)))).reduce(
    (s, a) => s + a.balance,
    0
  );
  assert.equal(total, 3000, 'no coins created or lost');
  assert.equal((await getMarket(id)).status, 'resolved');
  assert.match((await settleMarket(guild, id, 1)).error, /już rozstrzygnięty/);
  const bets = await betsOfMarket(id);
  assert.ok(bets.every((b) => b.payout !== null));
  const board = await topPredictors(guild);
  assert.equal(board[0].userId, B);
  assert.equal(board[0].profit, 450);
  assert.equal((await userBets(guild, C))[0].payout, 0);
});

test('settleMarket refunds everyone when nobody backed the winner', async () => {
  const guild = '800000000000000026';
  await enable(guild);
  const id = await createCustomMarket(guild, { question: 'Trzy opcje?', options: 'a\nb\nc' });
  await credit(guild, A, 500);
  await credit(guild, B, 500);
  await placeBet(guild, A, id, 0, 200);
  await placeBet(guild, B, id, 1, 100);
  const result = await settleMarket(guild, id, 2);
  assert.equal(result.ok, true);
  assert.equal(result.refunded, true);
  assert.equal((await getAccount(guild, A)).balance, 500);
  assert.equal((await getAccount(guild, B)).balance, 500);
});

test('cancelMarket returns every stake and blocks later bets and settlements', async () => {
  const guild = '800000000000000027';
  await enable(guild);
  const id = await createCustomMarket(guild, twoWay());
  await credit(guild, A, 300);
  await placeBet(guild, A, id, 0, 120);
  await placeBet(guild, A, id, 1, 80);
  assert.equal((await getAccount(guild, A)).balance, 100);
  const result = await cancelMarket(guild, id);
  assert.equal(result.ok, true);
  assert.equal(result.paid, 200);
  assert.equal((await getAccount(guild, A)).balance, 300);
  assert.equal((await getMarket(id)).status, 'cancelled');
  assert.match((await placeBet(guild, A, id, 0, 50)).error, /zamknięty/);
  assert.match((await settleMarket(guild, id, 0)).error, /już rozstrzygnięty/);
  assert.match((await cancelMarket(guild, id)).error, /już rozstrzygnięty/);
});

test('bets racing a settlement either count or are refunded — coins are conserved', async () => {
  const guild = '800000000000000028';
  await enable(guild);
  const id = await createCustomMarket(guild, twoWay());
  const users = Array.from({ length: 12 }, (_, i) => `70000000000000${String(100 + i)}`);
  for (const u of users) await credit(guild, u, 200);
  await Promise.all([...users.map((u, i) => placeBet(guild, u, id, i % 2, 100)), settleMarket(guild, id, 0)]);
  // Whatever order they landed in, every coin is accounted for: balances plus
  // any bets that never got a payout (placed after settlement is impossible).
  const accounts = await Promise.all(users.map((u) => getAccount(guild, u)));
  const held = accounts.reduce((s, a) => s + a.balance, 0);
  const bets = await betsOfMarket(id);
  const unpaid = bets.filter((b) => b.payout === null).reduce((s, b) => s + b.amount, 0);
  const winnersExist = bets.some((b) => b.optionIdx === 0);
  assert.equal(unpaid, 0, 'no bet is left without a payout once the market is settled');
  const dust = 2400 - held;
  assert.ok(dust >= 0 && dust <= bets.length, `only rounding dust may disappear (got ${dust})`);
  if (!winnersExist) assert.equal(held, 2400);
});

test('marketsOverview lists markets with pool shares', async () => {
  const guild = '800000000000000029';
  await enable(guild);
  const id = await createCustomMarket(guild, twoWay());
  await credit(guild, A, 500);
  await placeBet(guild, A, id, 0, 100);
  const view = await marketsOverview({ id: guild });
  assert.equal(view.markets.length, 1);
  assert.equal(view.markets[0].total, 100);
  assert.equal(view.markets[0].options[0].share, 100);
});

// -------------------------------------------------------------- components ----

const fakeInteraction = (guildId, userId, customId, amount) => {
  const out = { replies: [], modals: [] };
  return {
    out,
    interaction: {
      guildId,
      customId,
      user: { id: userId },
      fields: { getTextInputValue: () => amount },
      reply: async (payload) => out.replies.push(payload),
      showModal: async (modal) => out.modals.push(modal),
    },
  };
};

test('bet button opens a stake form and the form places the bet', async () => {
  const { handleBetButton, handleBetModal } = await import('../src/modules/markets.js');
  const guild = '800000000000000030';
  await enable(guild);
  const id = await createCustomMarket(guild, twoWay());
  await credit(guild, A, 400);

  const button = fakeInteraction(guild, A, `mkt:b:${id}:1`);
  await handleBetButton(button.interaction);
  assert.equal(button.out.modals.length, 1);
  assert.equal(button.out.modals[0].data.custom_id, `mkt:m:${id}:1`);

  const modal = fakeInteraction(guild, A, `mkt:m:${id}:1`, '150');
  await handleBetModal(modal.interaction);
  assert.match(modal.out.replies[0].content, /Postawiono na \*\*Nie\*\*/);
  assert.equal((await getAccount(guild, A)).balance, 250);

  const tooMuch = fakeInteraction(guild, A, `mkt:m:${id}:1`, '9999');
  await handleBetModal(tooMuch.interaction);
  assert.match(tooMuch.out.replies[0].content, /❌/);
  assert.equal((await getAccount(guild, A)).balance, 250);

  await settleMarket(guild, id, 0);
  const closed = fakeInteraction(guild, A, `mkt:b:${id}:0`);
  await handleBetButton(closed.interaction);
  assert.equal(closed.out.modals.length, 0);
  assert.match(closed.out.replies[0].content, /zamknięty/);
});

test('buildMarketMessage shows pools, Polymarket odds and one button per option', async () => {
  const { buildMarketMessage } = await import('../src/modules/markets.js');
  const market = {
    id: 7,
    question: 'Pytanie?',
    description: '',
    source: 'polymarket',
    status: 'open',
    winner: -1,
    closesAt: 0,
    options: Array.from({ length: 7 }, (_, i) => ({ label: `Opcja ${i}`, price: i === 0 ? 0.62 : null })),
  };
  const pools = market.options.map((_, i) => ({ total: i === 0 ? 300 : 100, bets: 1 }));
  const msg = buildMarketMessage(market, pools, { currencyEmoji: '🪙', currencyName: 'monet' });
  const text = msg.embeds[0].data.description;
  assert.match(text, /Polymarket: 62%/);
  assert.match(text, /x3\.00/);
  assert.match(text, /x9\.00/);
  assert.equal(msg.components.length, 2, 'seven buttons need two rows');
  assert.equal(msg.components[0].components.length, 5);
  const done = buildMarketMessage({ ...market, status: 'resolved', winner: 0 }, pools, {
    currencyEmoji: '🪙',
    currencyName: 'monet',
  });
  assert.equal(done.components.length, 0);
  assert.match(done.embeds[0].data.description, /✅ \*\*Opcja 0\*\*/);
});

test('trendingPolymarket reads both response shapes and falls back when an endpoint refuses', async () => {
  const { trendingPolymarket } = await import('../src/modules/markets.js');
  const realFetch = globalThis.fetch;
  const event = { slug: 'hot', title: 'Hot?', markets: [gammaMarket()] };
  const seen = [];
  try {
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes('/events/keyset')) return { ok: false, status: 422, json: async () => ({}) };
      return { ok: true, json: async () => [event] };
    };
    const viaFallback = await trendingPolymarket(5);
    assert.equal(viaFallback[0].slug, 'hot');
    assert.equal(viaFallback[0].options[0].percent, 62);
    assert.ok(seen.length >= 2, 'tried the next endpoint after a 422');

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ events: [event], next_cursor: 'x' }) });
    assert.equal((await trendingPolymarket(5))[0].slug, 'hot');

    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await assert.rejects(trendingPolymarket(5), /Nie udało się pobrać listy z Polymarketa.*500/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
