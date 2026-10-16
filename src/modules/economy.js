// Economy: virtual coins members earn from a daily reward (with a streak), from
// levelling up, and spend on a role shop, transfers and mini-games. The coins
// have no real-world value and cannot be bought or cashed out.
//
// config shape (see normaliseEconomy):
//   { currencyName, currencyEmoji, startingBalance,
//     daily:        { enabled, rewards: [day1, day2, …], cooldownHours, graceHours, loop },
//     levelRewards: { enabled, mode: 'flat'|'scaled', amount, milestones: [{ level, amount }], notify },
//     transfers:    { enabled, minAmount, feePercent },
//     shop:         { enabled, items: [{ roleId, price }] },
//     games:        { enabled, minBet, maxBet, cooldownSeconds, channelIds: [] } }
import { on } from './dispatch.js';
import { sendToChannel } from './lib/send.js';
import { credit, ensureAccount, getAccount, recordDailyClaim, MAX_BALANCE } from '../db/economy.js';

export const DAILY_MAX_DAYS = 31;
export const MAX_PAYOUT = 1_000_000_000;
export const LEVEL_REWARD_MODES = ['flat', 'scaled'];
export const DEFAULT_DAILY_REWARDS = [100, 150, 200, 250, 300, 400, 500];
const MAX_MILESTONES = 50;
const MAX_SHOP_ITEMS = 25;
const MAX_LEVEL_CATCHUP = 200;

const clampInt = (v, min, max, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const snowflake = (v) => (typeof v === 'string' && /^\d{17,20}$/.test(v) ? v : '');
const flag = (value, fallback) => (value === undefined ? fallback : value === true || value === 'on');
const text = (value, fallback, max) =>
  String(value ?? '')
    .replace(/[\r\n`*_~|<>@]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || fallback;
// A unicode emoji or a custom one (<:name:id> / <a:name:id>).
const emoji = (value, fallback) => {
  const v = String(value ?? '').trim();
  return v && v.length <= 40 && !/[\r\n`*@]/.test(v) ? v : fallback;
};

export function normaliseEconomy(raw = {}) {
  const daily = raw.daily ?? {};
  const lvl = raw.levelRewards ?? {};
  const transfers = raw.transfers ?? {};
  const shop = raw.shop ?? {};
  const games = raw.games ?? {};

  const rewards = (Array.isArray(daily.rewards) ? daily.rewards : [])
    .map((r) => clampInt(r, 0, MAX_PAYOUT, 0))
    .slice(0, DAILY_MAX_DAYS);

  const minBet = clampInt(games.minBet, 1, MAX_PAYOUT, 10);
  const maxBet = clampInt(games.maxBet, minBet, MAX_PAYOUT, Math.max(1000, minBet));

  const seenLevels = new Set();
  const milestones = (Array.isArray(lvl.milestones) ? lvl.milestones : [])
    .map((m) => ({ level: clampInt(m?.level, 0, 1000, 0), amount: clampInt(m?.amount, 0, MAX_PAYOUT, 0) }))
    .filter((m) => {
      if (m.level < 1 || m.amount < 1 || seenLevels.has(m.level)) return false;
      seenLevels.add(m.level);
      return true;
    })
    .sort((a, b) => a.level - b.level)
    .slice(0, MAX_MILESTONES);

  const seenRoles = new Set();
  const items = (Array.isArray(shop.items) ? shop.items : [])
    .map((i) => ({ roleId: snowflake(String(i?.roleId ?? '')), price: clampInt(i?.price, 0, MAX_PAYOUT, 0) }))
    .filter((i) => {
      if (!i.roleId || i.price < 1 || seenRoles.has(i.roleId)) return false;
      seenRoles.add(i.roleId);
      return true;
    })
    .slice(0, MAX_SHOP_ITEMS);

  return {
    currencyName: text(raw.currencyName, 'monet', 24),
    currencyEmoji: emoji(raw.currencyEmoji, '🪙'),
    startingBalance: clampInt(raw.startingBalance, 0, 1_000_000, 0),
    daily: {
      enabled: flag(daily.enabled, true),
      rewards: rewards.length ? rewards : [...DEFAULT_DAILY_REWARDS],
      cooldownHours: clampInt(daily.cooldownHours, 1, 168, 24),
      graceHours: clampInt(daily.graceHours, 0, 168, 24),
      loop: flag(daily.loop, true),
    },
    levelRewards: {
      enabled: flag(lvl.enabled, false),
      mode: LEVEL_REWARD_MODES.includes(lvl.mode) ? lvl.mode : 'flat',
      amount: clampInt(lvl.amount, 0, MAX_PAYOUT, 50),
      milestones,
      notify: flag(lvl.notify, true),
    },
    transfers: {
      enabled: flag(transfers.enabled, true),
      minAmount: clampInt(transfers.minAmount, 1, MAX_PAYOUT, 1),
      feePercent: clampInt(transfers.feePercent, 0, 50, 0),
    },
    shop: { enabled: flag(shop.enabled, false), items },
    games: {
      enabled: flag(games.enabled, false),
      minBet,
      maxBet,
      cooldownSeconds: clampInt(games.cooldownSeconds, 0, 600, 5),
      channelIds: [...new Set((Array.isArray(games.channelIds) ? games.channelIds : []).map(snowflake))]
        .filter(Boolean)
        .slice(0, 100),
    },
  };
}

/** "1 234 monet 🪙" — grouped with spaces, currency name then emoji. */
export function formatCoins(config, amount) {
  const n = Math.floor(Number(amount) || 0)
    .toLocaleString('pl-PL')
    .replace(/\u00a0/g, ' ');
  return `**${n}** ${config.currencyEmoji}`;
}

/** Plain "1 234 monet" (no emoji, no markdown) for places that can't take either. */
export function coinsText(config, amount) {
  const n = Math.floor(Number(amount) || 0)
    .toLocaleString('pl-PL')
    .replace(/\u00a0/g, ' ');
  return `${n} ${config.currencyName}`;
}

// ------------------------------------------------------------------ daily ----

/** The day of the reward cycle (1-based) a given streak length lands on. */
export function dayForStreak(daily, streak) {
  const days = daily.rewards.length;
  const s = Math.max(1, Math.floor(streak));
  return daily.loop ? ((s - 1) % days) + 1 : Math.min(s, days);
}

/**
 * What claiming right now would do, without touching the database.
 * A claim is allowed once `cooldownHours` have passed since the last one; the
 * streak survives until a further `graceHours` have passed, after which the next
 * claim starts again from day 1.
 * @param {ReturnType<typeof normaliseEconomy>['daily']} daily
 * @param {{ dailyStreak: number, lastDailyAt: number }} account
 */
export function previewDaily(daily, account, now = Date.now()) {
  const last = account.lastDailyAt;
  const cooldownMs = daily.cooldownHours * 3_600_000;
  const nextClaimAt = last ? last + cooldownMs : 0;
  const streakEndsAt = last ? nextClaimAt + daily.graceHours * 3_600_000 : 0;
  const canClaim = now >= nextClaimAt;
  const streakAlive = last > 0 && now < streakEndsAt;
  const newStreak = streakAlive ? account.dailyStreak + 1 : 1;
  const day = dayForStreak(daily, newStreak);
  return {
    canClaim,
    nextClaimAt,
    streakEndsAt,
    streakAlive,
    streakBroken: last > 0 && !streakAlive && account.dailyStreak > 1,
    newStreak,
    day,
    reward: daily.rewards[day - 1],
  };
}

/**
 * Claim the daily reward. Safe against double clicks and concurrent commands.
 * @returns {Promise<
 *   { ok: false, reason: 'disabled' } |
 *   { ok: false, reason: 'cooldown', nextClaimAt: number } |
 *   { ok: true, reward: number, day: number, streak: number, bestStreak: number, balance: number, streakBroken: boolean }>}
 */
export async function claimDaily(guildId, userId, config, now = Date.now()) {
  if (!config.daily.enabled) return { ok: false, reason: 'disabled' };
  await ensureAccount(guildId, userId, config.startingBalance);
  const account = await getAccount(guildId, userId);
  const preview = previewDaily(config.daily, account, now);
  if (!preview.canClaim) return { ok: false, reason: 'cooldown', nextClaimAt: preview.nextClaimAt };

  const result = await recordDailyClaim(guildId, userId, {
    previousClaimAt: account.lastDailyAt,
    streak: preview.newStreak,
    reward: preview.reward,
    now,
  });
  if (!result) {
    // Lost a race with another claim for the same member: report its cooldown.
    const fresh = await getAccount(guildId, userId);
    return { ok: false, reason: 'cooldown', nextClaimAt: previewDaily(config.daily, fresh, now).nextClaimAt };
  }
  return {
    ok: true,
    reward: preview.reward,
    day: preview.day,
    streak: result.dailyStreak,
    bestStreak: result.bestStreak,
    balance: result.balance,
    streakBroken: preview.streakBroken,
  };
}

// ----------------------------------------------------------- level rewards ----

/** Coins for reaching exactly `level` (0 when level rewards are off). */
export function levelRewardFor(config, level) {
  const lr = config.levelRewards;
  if (!lr.enabled) return 0;
  const base = lr.mode === 'scaled' ? level * lr.amount : lr.amount;
  const bonus = lr.milestones.find((m) => m.level === level)?.amount ?? 0;
  return Math.min(MAX_PAYOUT, Math.max(0, base + bonus));
}

/** Coins for every level gained going from `previousLevel` up to `level`. */
export function levelRewardTotal(config, previousLevel, level) {
  const from = Math.max(0, Math.floor(previousLevel));
  const to = Math.min(Math.floor(level), from + MAX_LEVEL_CATCHUP);
  let total = 0;
  for (let l = from + 1; l <= to; l += 1) total += levelRewardFor(config, l);
  return Math.min(total, MAX_BALANCE);
}

/** Pay out the level-up bonus. Returns the coins granted (0 if none). */
export async function grantLevelReward(guildId, userId, rawConfig, previousLevel, level) {
  const config = normaliseEconomy(rawConfig);
  const amount = levelRewardTotal(config, previousLevel, level);
  if (amount <= 0) return 0;
  await credit(guildId, userId, amount, config.startingBalance);
  return amount;
}

// Fired by the leveling module via dispatch('levelUp', …) once per level-up.
on('economy', 'levelUp', async ({ member, previousLevel, level, channelId }, rawConfig, guildId) => {
  const config = normaliseEconomy(rawConfig);
  if (!config.levelRewards.enabled || member.user?.bot) return;
  const amount = await grantLevelReward(guildId, member.id, rawConfig, previousLevel, level);
  if (amount > 0 && config.levelRewards.notify && channelId) {
    await sendToChannel(guildId, channelId, {
      content: `${config.currencyEmoji} <@${member.id}> dostaje **${amount.toLocaleString('pl-PL')}** ${config.currencyName} za poziom **${level}**!`,
      allowedMentions: { parse: [] },
    });
  }
});
