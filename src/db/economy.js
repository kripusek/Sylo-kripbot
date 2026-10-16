// Per-member virtual-coin accounts for the economy module.
//
// Every balance change is a single atomic statement (a guarded UPDATE for
// debits, an upsert-increment for credits, an optimistic-concurrency UPDATE for
// the daily claim), so two commands racing each other — a double-clicked
// /ekonomia daily, a game bet fired twice, a transfer while a level-up lands —
// can never overspend, double-claim or lose an update. Same approach as
// leveling.js's addXp (see the note there on why no db.transaction()).
//
// Balances are BIGINT on Postgres and capped at MAX_BALANCE so they always fit a
// JS safe integer on both drivers.
import { prepare, registerPostgresBootstrap } from './driver.js';

export const MAX_BALANCE = 1_000_000_000_000;

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS economy_accounts (
    guild_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    balance       BIGINT NOT NULL DEFAULT 0,
    daily_streak  INTEGER NOT NULL DEFAULT 0,
    best_streak   INTEGER NOT NULL DEFAULT 0,
    daily_claims  INTEGER NOT NULL DEFAULT 0,
    last_daily_at BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_economy_balance ON economy_accounts (guild_id, balance DESC);
`);

const getStmt = prepare('SELECT * FROM economy_accounts WHERE guild_id = ? AND user_id = ?');
const ensureStmt = prepare(`
  INSERT INTO economy_accounts (guild_id, user_id, balance)
  VALUES (@guildId, @userId, @start)
  ON CONFLICT (guild_id, user_id) DO NOTHING
`);
const creditStmt = prepare(`
  INSERT INTO economy_accounts (guild_id, user_id, balance)
  VALUES (@guildId, @userId, @initial)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    balance = CASE
      WHEN economy_accounts.balance + @amount > @max THEN @max
      ELSE economy_accounts.balance + @amount
    END
  RETURNING balance
`);
const debitStmt = prepare(`
  UPDATE economy_accounts SET balance = balance - @amount
  WHERE guild_id = @guildId AND user_id = @userId AND balance >= @amount
  RETURNING balance
`);
// Optimistic concurrency: only succeeds while last_daily_at is still the value
// the caller computed the streak from, so a concurrent second claim updates 0 rows.
const claimStmt = prepare(`
  UPDATE economy_accounts SET
    balance = CASE WHEN balance + @reward > @max THEN @max ELSE balance + @reward END,
    daily_streak = @streak,
    best_streak = CASE WHEN best_streak > @streak THEN best_streak ELSE @streak END,
    daily_claims = daily_claims + 1,
    last_daily_at = @now
  WHERE guild_id = @guildId AND user_id = @userId AND last_daily_at = @previousClaimAt
  RETURNING balance, daily_streak, best_streak
`);
const topStmt = prepare(
  'SELECT user_id, balance FROM economy_accounts WHERE guild_id = ? AND balance > 0 ORDER BY balance DESC, user_id LIMIT ? OFFSET ?'
);
const rankStmt = prepare('SELECT COUNT(*) AS n FROM economy_accounts WHERE guild_id = ? AND balance > ?');
const countStmt = prepare('SELECT COUNT(*) AS n FROM economy_accounts WHERE guild_id = ? AND balance > 0');
const setBalanceStmt = prepare(`
  INSERT INTO economy_accounts (guild_id, user_id, balance)
  VALUES (@guildId, @userId, @balance)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET balance = @balance
`);

const EMPTY = { balance: 0, dailyStreak: 0, bestStreak: 0, dailyClaims: 0, lastDailyAt: 0 };

const num = (v) => Number(v) || 0;
const toAccount = (guildId, userId, row) =>
  row
    ? {
        guildId,
        userId,
        balance: num(row.balance),
        dailyStreak: num(row.daily_streak),
        bestStreak: num(row.best_streak),
        dailyClaims: num(row.daily_claims),
        lastDailyAt: num(row.last_daily_at),
      }
    : { guildId, userId, ...EMPTY };

const wholeAmount = (amount) => {
  const n = Math.floor(Number(amount));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_BALANCE) : 0;
};

/** The member's account (all zeros if they have never used the economy). */
export async function getAccount(guildId, userId) {
  return toAccount(guildId, userId, await getStmt.get(guildId, userId));
}

/** Create the account with `startingBalance` if it doesn't exist yet. Idempotent. */
export async function ensureAccount(guildId, userId, startingBalance = 0) {
  await ensureStmt.run({ guildId, userId, start: wholeAmount(startingBalance) });
}

/**
 * Add coins (capped at MAX_BALANCE). If the account doesn't exist yet it is
 * created with `startingBalance` + `amount`.
 * @returns {Promise<number>} the new balance
 */
export async function credit(guildId, userId, amount, startingBalance = 0) {
  const add = wholeAmount(amount);
  const initial = Math.min(wholeAmount(startingBalance) + add, MAX_BALANCE);
  const row = await creditStmt.get({ guildId, userId, initial, amount: add, max: MAX_BALANCE });
  return num(row.balance);
}

/**
 * Remove coins only if the member can afford it — one atomic guarded UPDATE.
 * @returns {Promise<number | null>} the new balance, or null when they can't afford it
 */
export async function debit(guildId, userId, amount) {
  const take = wholeAmount(amount);
  if (take <= 0) return null;
  const row = await debitStmt.get({ guildId, userId, amount: take });
  return row ? num(row.balance) : null;
}

/**
 * Record a daily claim, but only if `previousClaimAt` is still the account's
 * last claim time (so a racing duplicate claim loses). Call ensureAccount first.
 * @returns {Promise<{ balance: number, dailyStreak: number, bestStreak: number } | null>} null when the claim lost the race
 */
export async function recordDailyClaim(guildId, userId, { previousClaimAt, streak, reward, now }) {
  const row = await claimStmt.get({
    guildId,
    userId,
    previousClaimAt: Math.floor(previousClaimAt),
    streak: Math.max(1, Math.floor(streak)),
    reward: wholeAmount(reward),
    now: Math.floor(now),
    max: MAX_BALANCE,
  });
  return row
    ? { balance: num(row.balance), dailyStreak: num(row.daily_streak), bestStreak: num(row.best_streak) }
    : null;
}

/** Richest members first. */
export async function topBalances(guildId, limit = 10, offset = 0) {
  return (await topStmt.all(guildId, limit, offset)).map((r) => ({
    userId: r.user_id,
    balance: num(r.balance),
  }));
}

/** 1-based rank of a balance within the guild. */
export async function balanceRank(guildId, balance) {
  return (num((await rankStmt.get(guildId, balance))?.n) || 0) + 1;
}

/** How many members hold a positive balance. */
export async function accountCount(guildId) {
  return num((await countStmt.get(guildId))?.n);
}

/** Set an exact balance (dashboard / admin correction). */
export async function setBalance(guildId, userId, balance) {
  await setBalanceStmt.run({ guildId, userId, balance: wholeAmount(balance) });
}
