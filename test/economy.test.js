import './helpers/tmpDb.js';
import test from 'node:test';
import { dispatch } from '../src/modules/dispatch.js';
import { setGuildModule } from '../src/db/modules.js';
import assert from 'node:assert/strict';
import { getAccount, credit, debit, topBalances, balanceRank, MAX_BALANCE } from '../src/db/economy.js';
import {
  normaliseEconomy,
  previewDaily,
  claimDaily,
  dayForStreak,
  levelRewardFor,
  levelRewardTotal,
  grantLevelReward,
  adjustBalance,
  reserveActivity,
  richestMembers,
  _internals,
} from '../src/modules/economy.js';
import {
  coinflip,
  guessNumber,
  rps,
  dice,
  slots,
  roulette,
  rouletteColor,
  rouletteWins,
  cups,
  payoutFor,
  evaluateHand,
  compareHands,
  poker,
  newDeck,
  shuffle,
  blackjackValue,
  blackjackDeal,
  blackjackHit,
  blackjackStand,
  blackjackSettle,
  SLOT_SYMBOLS,
  SLOTS_JACKPOT_MULTIPLIER,
  SLOTS_PAIR_MULTIPLIER,
  ROULETTE_POCKETS,
  ROULETTE_MULTIPLIERS,
  GUESS_MULTIPLIER,
  CUPS_MULTIPLIER,
  COINFLIP_MULTIPLIER,
  DICE_WIN_MULTIPLIER,
} from '../src/modules/lib/economyGames.js';

const G = '111111111111111111';
let n = 0;
const user = () => `2${String(++n).padStart(17, '0')}`;
const H = 3_600_000;
const card = (rank, suit) => ({ rank, suit });
const hand = (...codes) =>
  codes.map((c) => card({ T: 10, J: 11, Q: 12, K: 13, A: 14 }[c[0]] ?? Number(c[0]), c[1]));
const script = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test('config is clamped and defaults are filled in', () => {
  const d = normaliseEconomy({});
  assert.equal(d.currencyName, 'monet');
  assert.deepEqual(d.daily.rewards, [100, 150, 200, 250, 300, 400, 500]);
  assert.equal(d.daily.enabled, true);
  assert.equal(d.levelRewards.enabled, false);
  assert.equal(d.games.enabled, false);
  assert.equal(d.shop.enabled, false);

  const c = normaliseEconomy({
    currencyName: '  `Złoto*  ',
    startingBalance: -5,
    daily: {
      rewards: ['10', 'x', 20.9, ...Array(40).fill(1)],
      cooldownHours: 9999,
      graceHours: -1,
      loop: false,
    },
    levelRewards: {
      enabled: true,
      mode: 'weird',
      amount: '25',
      milestones: [
        { level: 10, amount: 500 },
        { level: 10, amount: 900 },
        { level: 5, amount: 100 },
        { level: 0, amount: 100 },
        { level: 7, amount: 0 },
      ],
    },
    transfers: { feePercent: 99, minAmount: 0 },
    shop: {
      enabled: true,
      items: [
        { roleId: '123456789012345678', price: 50 },
        { roleId: 'bad', price: 5 },
        { roleId: '123456789012345678', price: 9 },
      ],
    },
    games: { minBet: 50, maxBet: 10, channelIds: ['123456789012345678', 'nope', '123456789012345678'] },
  });
  assert.equal(c.currencyName, 'Złoto');
  assert.equal(c.startingBalance, 0);
  assert.equal(c.daily.rewards.length, 31);
  assert.deepEqual(c.daily.rewards.slice(0, 3), [10, 0, 20]);
  assert.equal(c.daily.cooldownHours, 168);
  assert.equal(c.daily.graceHours, 0);
  assert.equal(c.daily.loop, false);
  assert.equal(c.levelRewards.mode, 'flat');
  assert.deepEqual(c.levelRewards.milestones, [
    { level: 5, amount: 100 },
    { level: 10, amount: 500 },
  ]);
  assert.equal(c.transfers.feePercent, 50);
  assert.equal(c.transfers.minAmount, 1);
  assert.deepEqual(c.shop.items, [{ roleId: '123456789012345678', price: 50 }]);
  assert.equal(c.games.maxBet, 50); // never below the minimum
  assert.deepEqual(c.games.channelIds, ['123456789012345678']);
  // Unticked checkboxes arrive as `false`, not undefined.
  assert.equal(normaliseEconomy({ daily: { enabled: false } }).daily.enabled, false);
});

test('balances: credit, guarded debit, cap and ranking', async () => {
  const a = user();
  const b = user();
  assert.equal((await getAccount(G, a)).balance, 0);
  assert.equal(await debit(G, a, 5), null); // no account yet
  assert.equal(await credit(G, a, 100, 25), 125); // starting balance applied on creation
  assert.equal(await credit(G, a, 50, 25), 175); // ...but only once
  assert.equal(await debit(G, a, 200), null);
  assert.equal(await debit(G, a, 75), 100);
  assert.equal(await debit(G, a, 0), null);
  assert.equal(await credit(G, a, MAX_BALANCE), MAX_BALANCE); // capped
  await credit(G, b, 10);
  const top = await topBalances(G, 100);
  assert.equal(top.find((r) => r.userId === a).balance, MAX_BALANCE);
  assert.equal(
    await balanceRank(G, 10),
    (await topBalances(G, 100)).filter((r) => r.balance > 10).length + 1
  );
});

test('concurrent debits can never overspend', async () => {
  const u = user();
  await credit(G, u, 100);
  const results = await Promise.all(Array.from({ length: 10 }, () => debit(G, u, 30)));
  assert.equal(results.filter((r) => r !== null).length, 3);
  assert.equal((await getAccount(G, u)).balance, 10);
});

test('daily preview: cooldown, streak window and day cycle', () => {
  const cfg = normaliseEconomy({ daily: { rewards: [10, 20, 30], cooldownHours: 24, graceHours: 12 } });
  const t0 = 1_000_000_000_000;
  const fresh = previewDaily(cfg.daily, { dailyStreak: 0, lastDailyAt: 0 }, t0);
  assert.deepEqual([fresh.canClaim, fresh.newStreak, fresh.day, fresh.reward], [true, 1, 1, 10]);

  const acc = { dailyStreak: 1, lastDailyAt: t0 };
  const early = previewDaily(cfg.daily, acc, t0 + 23 * H);
  assert.equal(early.canClaim, false);
  assert.equal(early.nextClaimAt, t0 + 24 * H);
  assert.equal(early.streakEndsAt, t0 + 36 * H);

  const next = previewDaily(cfg.daily, acc, t0 + 24 * H);
  assert.deepEqual([next.canClaim, next.newStreak, next.day, next.reward], [true, 2, 2, 20]);
  const edge = previewDaily(cfg.daily, acc, t0 + 36 * H - 1);
  assert.equal(edge.newStreak, 2);
  const late = previewDaily(cfg.daily, { dailyStreak: 5, lastDailyAt: t0 }, t0 + 36 * H);
  assert.deepEqual([late.newStreak, late.day, late.streakBroken], [1, 1, true]);

  assert.equal(dayForStreak(cfg.daily, 3), 3);
  assert.equal(dayForStreak(cfg.daily, 4), 1); // loops
  assert.equal(dayForStreak({ ...cfg.daily, loop: false }, 9), 3); // stays on the last day
});

test('claimDaily: pays, builds a streak, enforces the timer and survives double clicks', async () => {
  const cfg = normaliseEconomy({
    daily: { rewards: [10, 20, 30], cooldownHours: 24, graceHours: 12 },
    startingBalance: 5,
  });
  const u = user();
  const t0 = 2_000_000_000_000;

  const first = await claimDaily(G, u, cfg, t0);
  assert.deepEqual([first.ok, first.reward, first.day, first.streak, first.balance], [true, 10, 1, 1, 15]);

  const again = await claimDaily(G, u, cfg, t0 + H);
  assert.deepEqual([again.ok, again.reason, again.nextClaimAt], [false, 'cooldown', t0 + 24 * H]);

  const second = await claimDaily(G, u, cfg, t0 + 24 * H);
  assert.deepEqual([second.reward, second.day, second.streak, second.balance], [20, 2, 2, 35]);

  const miss = await claimDaily(G, u, cfg, t0 + 24 * H + 24 * H + 12 * H); // streak window passed
  assert.deepEqual([miss.reward, miss.streak, miss.streakBroken, miss.bestStreak], [10, 1, true, 2]);

  assert.deepEqual(await claimDaily(G, user(), normaliseEconomy({ daily: { enabled: false } }), t0), {
    ok: false,
    reason: 'disabled',
  });

  const racer = user();
  const results = await Promise.all(Array.from({ length: 8 }, () => claimDaily(G, racer, cfg, t0)));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await getAccount(G, racer)).balance, 15); // paid exactly once
  assert.equal((await getAccount(G, racer)).dailyClaims, 1);
});

test('level rewards: flat, scaled, milestones, multi-level jumps and the off switch', async () => {
  const flat = normaliseEconomy({
    levelRewards: { enabled: true, mode: 'flat', amount: 50, milestones: [{ level: 10, amount: 1000 }] },
  });
  assert.equal(levelRewardFor(flat, 3), 50);
  assert.equal(levelRewardFor(flat, 10), 1050);
  const scaled = normaliseEconomy({ levelRewards: { enabled: true, mode: 'scaled', amount: 10 } });
  assert.equal(levelRewardFor(scaled, 7), 70);
  assert.equal(levelRewardTotal(scaled, 4, 7), 50 + 60 + 70); // levels 5, 6 and 7
  assert.equal(levelRewardTotal(scaled, 7, 7), 0);
  assert.equal(levelRewardFor(normaliseEconomy({}), 5), 0); // disabled by default

  const u = user();
  assert.equal(await grantLevelReward(G, u, flat, 9, 10), 1050);
  assert.equal((await getAccount(G, u)).balance, 1050);
  assert.equal(await grantLevelReward(G, u, { levelRewards: { enabled: false } }, 1, 2), 0);
  assert.equal((await getAccount(G, u)).balance, 1050);
});

test('simple games pay out the documented multipliers', () => {
  assert.deepEqual(coinflip('orzel', script(0)), {
    result: 'orzel',
    win: true,
    multiplier: COINFLIP_MULTIPLIER,
  });
  assert.equal(coinflip('orzel', script(1)).multiplier, 0);
  assert.equal(guessNumber(3, script(2)).multiplier, GUESS_MULTIPLIER); // rng 2 -> number 3
  assert.equal(guessNumber(3, script(0)).multiplier, 0);
  assert.equal(rps('kamien', script(2)).outcome, 'win'); // bot picks nozyce
  assert.equal(rps('kamien', script(1)).outcome, 'lose'); // bot picks papier
  assert.equal(rps('kamien', script(0)).outcome, 'draw');
  assert.deepEqual(dice(script(5, 0)).multiplier, DICE_WIN_MULTIPLIER); // 6 vs 1
  assert.equal(dice(script(0, 5)).multiplier, 0);
  assert.equal(dice(script(2, 2)).multiplier, 1); // tie refunds
  assert.equal(cups(2, script(1)).multiplier, CUPS_MULTIPLIER);
  assert.equal(cups(2, script(0)).multiplier, 0);
  assert.equal(payoutFor(100, 2.5), 250);
  assert.equal(payoutFor(3, 2.5), 7); // rounded down, never above the stated multiplier
  assert.equal(slots(script(0, 0, 0)).outcome, 'jackpot');
  assert.equal(slots(script(0, 0, 1)).multiplier, SLOTS_PAIR_MULTIPLIER);
  assert.equal(slots(script(0, 1, 2)).multiplier, 0);
});

test('roulette wheel and house edge', () => {
  assert.deepEqual(
    [rouletteColor(0), rouletteColor(1), rouletteColor(7), rouletteColor(8), rouletteColor(14)],
    ['zielone', 'czerwone', 'czerwone', 'czarne', 'czarne']
  );
  assert.equal(roulette('zielone', script(0)).multiplier, 14);
  assert.equal(roulette('czerwone', script(3)).multiplier, 2);
  assert.equal(roulette('czerwone', script(9)).multiplier, 0);
  for (const type of ['czerwone', 'czarne', 'zielone']) {
    let total = 0;
    for (let pocket = 0; pocket < ROULETTE_POCKETS; pocket += 1)
      total += roulette(type, () => pocket).multiplier;
    const rtp = total / ROULETTE_POCKETS;
    assert.ok(rtp < 1, `${type} must favour the house (RTP ${rtp})`);
    assert.ok(rtp > 0.9, `${type} should not be punishing (RTP ${rtp})`);
    assert.equal(ROULETTE_MULTIPLIERS[type] > 0, true);
  }
});

test('roulette even/odd and exact-number bets', () => {
  assert.equal(roulette('parzyste', script(4)).multiplier, 2);
  assert.equal(roulette('parzyste', script(3)).multiplier, 0);
  assert.equal(roulette('nieparzyste', script(3)).multiplier, 2);
  assert.equal(roulette('nieparzyste', script(14)).multiplier, 0);
  assert.equal(roulette('parzyste', script(0)).multiplier, 0, 'zero is neither even nor odd');
  assert.equal(roulette('nieparzyste', script(0)).multiplier, 0);
  assert.equal(roulette(7, script(7)).multiplier, 14);
  assert.equal(roulette(0, script(0)).multiplier, 14, 'exact 0 is a valid number bet');
  assert.equal(roulette(7, script(8)).multiplier, 0);
  assert.equal(rouletteWins('parzyste', 14), true);
  for (const type of ['parzyste', 'nieparzyste', 0, 5, 14]) {
    let total = 0;
    for (let pocket = 0; pocket < ROULETTE_POCKETS; pocket += 1)
      total += roulette(type, () => pocket).multiplier;
    const rtp = total / ROULETTE_POCKETS;
    assert.ok(rtp < 1 && rtp > 0.9, `${type} must favour the house without punishing (RTP ${rtp})`);
  }
});

test('no game gives the player an edge (exact return-to-player)', () => {
  const S = SLOT_SYMBOLS.length;
  let slotsTotal = 0;
  for (let a = 0; a < S; a += 1)
    for (let b = 0; b < S; b += 1)
      for (let c = 0; c < S; c += 1) slotsTotal += slots(script(a, b, c)).multiplier;
  const slotsRtp = slotsTotal / S ** 3;
  assert.ok(slotsRtp < 1 && slotsRtp > 0.7, `slots RTP ${slotsRtp}`);
  assert.equal(SLOTS_JACKPOT_MULTIPLIER > SLOTS_PAIR_MULTIPLIER, true);

  const rtp = (count, mult) => mult / count;
  assert.ok(rtp(5, GUESS_MULTIPLIER) <= 1);
  assert.ok(rtp(3, CUPS_MULTIPLIER) <= 1);
  let dicePay = 0;
  for (let p = 0; p < 6; p += 1) for (let q = 0; q < 6; q += 1) dicePay += dice(script(p, q)).multiplier;
  assert.ok(dicePay / 36 <= 1, `dice RTP ${dicePay / 36}`);
});

test('poker hand ranking and tie-breaks', () => {
  const rank = (...c) => evaluateHand(hand(...c));
  assert.equal(rank('AS', 'KS', 'QS', 'JS', 'TS').name, 'Poker królewski');
  assert.equal(rank('9H', '8H', '7H', '6H', '5H').name, 'Poker');
  assert.equal(rank('AH', '2H', '3H', '4H', '5H').category, 8); // wheel straight flush
  assert.equal(rank('9H', '9D', '9S', '9C', '2H').name, 'Kareta');
  assert.equal(rank('9H', '9D', '9S', '2C', '2H').name, 'Full');
  assert.equal(rank('2H', '7H', '9H', 'JH', 'KH').name, 'Kolor');
  assert.equal(rank('5H', '6D', '7S', '8C', '9H').name, 'Strit');
  assert.equal(rank('AH', '2D', '3S', '4C', '5H').name, 'Strit'); // wheel
  assert.equal(rank('9H', '9D', '9S', '3C', '2H').name, 'Trójka');
  assert.equal(rank('9H', '9D', '3S', '3C', '2H').name, 'Dwie pary');
  assert.equal(rank('9H', '9D', '4S', '3C', '2H').name, 'Para');
  assert.equal(rank('AH', '9D', '4S', '3C', '2H').name, 'Wysoka karta');

  const beats = (a, b) => compareHands(evaluateHand(hand(...a)), evaluateHand(hand(...b))) > 0;
  assert.ok(beats(['AH', 'AD', '4S', '3C', '2H'], ['KH', 'KD', 'QS', 'JC', '9H'])); // pair of aces over kings
  assert.ok(beats(['9H', '9D', 'AS', '3C', '2H'], ['9S', '9C', 'KS', '3D', '2D'])); // kicker decides
  assert.ok(beats(['5H', '6D', '7S', '8C', '9H'], ['AH', '2D', '3S', '4C', '5H'])); // 9-high straight beats the wheel
  assert.equal(
    compareHands(
      evaluateHand(hand('AH', 'KD', '4S', '3C', '2H')),
      evaluateHand(hand('AS', 'KC', '4D', '3H', '2D'))
    ),
    0
  );
  assert.ok(beats(['9H', '9D', '9S', '2C', '2H'], ['KH', 'KD', 'KS', 'QC', 'JH'])); // full house over trips
});

test('poker round deals ten distinct cards and settles the stake', () => {
  const r = poker(script(0));
  assert.equal(new Set([...r.player, ...r.bot].map((c) => `${c.rank}${c.suit}`)).size, 10);
  assert.equal(poker(() => 0).outcome === 'draw' ? 1 : poker(() => 0).multiplier, poker(() => 0).multiplier);
  const outcomes = new Set();
  for (let i = 0; i < 200; i += 1) outcomes.add(poker().outcome);
  assert.ok(outcomes.has('win') && outcomes.has('lose'));
  assert.equal(new Set(shuffle(newDeck(), () => 0).map((c) => `${c.rank}${c.suit}`)).size, 52);
});

test('blackjack values, naturals, dealer rules and settlement', () => {
  assert.equal(blackjackValue(hand('AS', 'KH')).total, 21);
  assert.equal(blackjackValue(hand('AS', 'AH', '9D')).total, 21); // 11 + 1 + 9
  assert.equal(blackjackValue(hand('AS', 'AH', 'AD')).total, 13);
  assert.equal(blackjackValue(hand('KS', 'QH', '5D')).total, 25);
  assert.equal(blackjackValue(hand('AS', '6H')).soft, true);

  const settle = (player, dealer) => blackjackSettle({ player: hand(...player), dealer: hand(...dealer) });
  assert.deepEqual(settle(['AS', 'KH'], ['9S', '8H']).multiplier, 2.5); // natural
  assert.equal(settle(['AS', 'KH'], ['AD', 'QH']).outcome, 'push'); // both natural
  assert.equal(settle(['9S', '9H', '3D'], ['AD', 'KH']).multiplier, 0); // dealer natural beats a 21
  assert.equal(settle(['KS', 'QH', '5D'], ['9S', '8H']).outcome, 'bust');
  assert.equal(settle(['KS', '9H'], ['KD', 'QH', '5C']).outcome, 'win'); // dealer busts
  assert.equal(settle(['KS', '9H'], ['KD', '9C']).outcome, 'push');
  assert.equal(settle(['KS', '8H'], ['KD', '9C']).multiplier, 0);

  // A scripted deal: player 10+9, dealer 6+5 then draws to 17+.
  const fixed = blackjackDeal(() => 0);
  assert.equal(fixed.player.length, 2);
  const state = {
    deck: hand('4D', 'KC', '7H'),
    player: hand('TS', '9H'),
    dealer: hand('6S', '5H'),
    done: false,
    result: null,
  };
  blackjackStand(state); // dealer draws 7 (-> 18) and stops
  assert.equal(state.dealer.length, 3);
  assert.equal(state.result.outcome, 'win'); // 19 against 18

  const hit = {
    deck: hand('5D', 'KC', 'QH'),
    player: hand('TS', '9H'),
    dealer: hand('6S', 'KH'),
    done: false,
    result: null,
  };
  blackjackHit(hit); // draws Q -> bust
  assert.equal(hit.done, true);
  assert.equal(hit.result.outcome, 'bust');
  assert.equal(blackjackHit(hit), hit); // no-op once finished

  const naturals = new Set();
  for (let i = 0; i < 400; i += 1) {
    const s = blackjackDeal();
    if (s.done) naturals.add(s.result.outcome);
  }
  assert.ok(naturals.size > 0);
});

test('activity config is clamped and off by default', () => {
  const d = normaliseEconomy({});
  assert.equal(d.activity.messages.enabled, false);
  assert.equal(d.activity.voice.enabled, false);
  const c = normaliseEconomy({
    activity: {
      messages: { enabled: true, amount: 0, cooldownSeconds: 1, dailyCap: -4 },
      voice: { enabled: true, perMinute: 'x', dailyCap: 5 },
    },
  });
  assert.deepEqual(c.activity.messages, { enabled: true, amount: 1, cooldownSeconds: 5, dailyCap: 0 });
  assert.deepEqual(c.activity.voice, { enabled: true, perMinute: 1, dailyCap: 5 });
});

test('daily activity caps clip payouts and reset the next day', () => {
  const u = user();
  const day = 86_400_000;
  const t = 40 * day;
  assert.equal(reserveActivity('msg', G, u, 4, 10, t), 4);
  assert.equal(reserveActivity('msg', G, u, 4, 10, t), 4);
  assert.equal(reserveActivity('msg', G, u, 4, 10, t), 2); // only 2 left today
  assert.equal(reserveActivity('msg', G, u, 4, 10, t), 0);
  assert.equal(reserveActivity('voice', G, u, 4, 10, t), 4); // separate tally per source
  assert.equal(reserveActivity('msg', G, u, 4, 10, t + day), 4); // new day
  assert.equal(reserveActivity('msg', G, u, 999, 0, t + day), 999); // 0 = unlimited
});

test('chatting pays coins once per cooldown and respects the toggle', async () => {
  const GID = '333333333333333333';
  const u = user();
  const msg = { author: { id: u, bot: false }, inGuild: () => true };
  await setGuildModule(GID, 'economy', {
    enabled: true,
    config: { activity: { messages: { enabled: true, amount: 3, cooldownSeconds: 60, dailyCap: 5 } } },
  });
  await dispatch('messageCreate', GID, msg);
  await dispatch('messageCreate', GID, msg); // inside the cooldown
  assert.equal((await getAccount(GID, u)).balance, 3);

  _internals.messageCooldowns.clear();
  await dispatch('messageCreate', GID, msg); // cap of 5 leaves 2
  assert.equal((await getAccount(GID, u)).balance, 5);
  _internals.messageCooldowns.clear();
  await dispatch('messageCreate', GID, msg);
  assert.equal((await getAccount(GID, u)).balance, 5);

  const bot = { author: { id: user(), bot: true }, inGuild: () => true };
  await dispatch('messageCreate', GID, bot);
  assert.equal((await getAccount(GID, bot.author.id)).balance, 0);

  await setGuildModule(GID, 'economy', { enabled: true, config: {} });
  _internals.earned.clear();
  _internals.messageCooldowns.clear();
  await dispatch('messageCreate', GID, msg);
  assert.equal((await getAccount(GID, u)).balance, 5); // activity pay is off by default
});

test('voice time pays per minute only when the member is not alone', async () => {
  const GID = '444444444444444444';
  const a = user();
  const b = user();
  await setGuildModule(GID, 'economy', {
    enabled: true,
    config: { activity: { voice: { enabled: true, perMinute: 2, dailyCap: 0 } } },
  });
  const { runtime } = await import('../src/runtime.js');
  const states = new Map();
  const vs = (id, channelId, extra = {}) => ({ id, channelId, member: { user: { bot: false } }, ...extra });
  runtime.client = {
    guilds: { cache: new Map([[GID, { afkChannelId: 'afk', voiceStates: { cache: states } }]]) },
  };
  const raw = { activity: { voice: { enabled: true, perMinute: 2, dailyCap: 0 } } };
  const t0 = Date.now();
  const minutes = (n) => t0 + n * 60_000;

  states.set(a, vs(a, 'vc1'));
  await _internals.settleVoice(GID, a, { at: t0, channelId: 'vc1' }, minutes(5), raw, { keepOpen: false });
  assert.equal((await getAccount(GID, a)).balance, 0); // alone in the channel

  states.set(b, vs(b, 'vc1'));
  await _internals.settleVoice(GID, a, { at: t0, channelId: 'vc1' }, minutes(5), raw, { keepOpen: false });
  assert.equal((await getAccount(GID, a)).balance, 10);

  const session = { at: t0, channelId: 'vc1' };
  await _internals.settleVoice(GID, b, session, minutes(3) + 30_000, raw, { keepOpen: true });
  assert.equal((await getAccount(GID, b)).balance, 6);
  assert.equal(session.at, minutes(3)); // the half minute carries over

  states.set(b, vs(b, 'vc1', { selfDeaf: true }));
  await _internals.settleVoice(GID, b, { at: t0, channelId: 'vc1' }, minutes(5), raw, { keepOpen: false });
  assert.equal((await getAccount(GID, b)).balance, 6); // deafened earns nothing
  delete runtime.client;
});

test('admin adjustments add, remove (never below zero) and set', async () => {
  const GID = '555555555555555555';
  const u = user();
  assert.deepEqual(await adjustBalance(GID, u, 'add', 500, 10), { ok: true, balance: 510 });
  assert.deepEqual(await adjustBalance(GID, u, 'remove', 100), { ok: true, balance: 410 });
  assert.deepEqual(await adjustBalance(GID, u, 'remove', 9999), { ok: true, balance: 0 }); // clamps at zero
  assert.deepEqual(await adjustBalance(GID, u, 'set', 42), { ok: true, balance: 42 });
  assert.deepEqual(await adjustBalance(GID, u, 'set', 0), { ok: true, balance: 0 });
  for (const [action, amount] of [
    ['add', 0],
    ['add', -5],
    ['remove', 0],
    ['bogus', 5],
    ['add', 1.5],
    ['add', NaN],
    ['set', -1],
  ])
    assert.equal((await adjustBalance(GID, u, action, amount)).ok, false, `${action} ${amount}`);
  assert.equal((await getAccount(GID, u)).balance, 0);
});

test('richestMembers ranks by balance and resolves display names', async () => {
  const GID = '666666666666666666';
  const [x, y, z] = [user(), user(), user()];
  await credit(GID, x, 30);
  await credit(GID, y, 90);
  await credit(GID, z, 60);
  const guild = { id: GID, members: { cache: new Map([[y, { displayName: 'Yaya' }]]) } };
  const rows = await richestMembers(guild, 2);
  assert.deepEqual(rows, [
    { rank: 1, userId: y, name: 'Yaya', balance: 90 },
    { rank: 2, userId: z, name: z, balance: 60 }, // not cached -> id
  ]);
});
