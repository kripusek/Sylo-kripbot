// Steam account links and "bet on my next CS2 match" stakes.
//
// A link ties a Discord member to a SteamID64 Steam itself vouched for (Steam
// OpenID), within one guild; a SteamID64 can belong to one member only, so a
// second Discord account can't bet on somebody else's matches. A stake holds
// coins until the player's next match is known; settling is a guarded UPDATE
// (status = 'pending'), so a result is paid exactly once.
import { MAX_BALANCE } from './economy.js';
import { prepare, registerPostgresBootstrap, runAtomicWrites } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS steam_links (
    guild_id  TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    steam_id  TEXT NOT NULL,
    linked_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_steam_links_steam ON steam_links (guild_id, steam_id);
  CREATE TABLE IF NOT EXISTS cs2_bets (
    id         SERIAL PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    steam_id   TEXT NOT NULL,
    amount     BIGINT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    payout     BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    settled_at BIGINT NOT NULL DEFAULT 0,
    mode       TEXT NOT NULL DEFAULT 'any',
    channel_id TEXT NOT NULL DEFAULT '',
    target_id  TEXT NOT NULL DEFAULT '',
    pick       TEXT NOT NULL DEFAULT 'win'
  );
  ALTER TABLE cs2_bets ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'any';
  ALTER TABLE cs2_bets ADD COLUMN IF NOT EXISTS channel_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE cs2_bets ADD COLUMN IF NOT EXISTS target_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE cs2_bets ADD COLUMN IF NOT EXISTS pick TEXT NOT NULL DEFAULT 'win';
  CREATE INDEX IF NOT EXISTS idx_cs2_bets_status ON cs2_bets (status, id);
  CREATE INDEX IF NOT EXISTS idx_cs2_bets_user ON cs2_bets (guild_id, user_id, id);
`);

const num = (v) => Number(v) || 0;
const toBet = (r) =>
  r
    ? {
        id: num(r.id),
        guildId: r.guild_id,
        userId: r.user_id,
        steamId: r.steam_id,
        amount: num(r.amount),
        status: r.status,
        payout: num(r.payout),
        createdAt: num(r.created_at),
        settledAt: num(r.settled_at),
        mode: r.mode,
        channelId: r.channel_id ?? '',
        targetId: r.target_id ?? '',
        pick: r.pick || 'win',
      }
    : null;

const getLinkStmt = prepare('SELECT steam_id FROM steam_links WHERE guild_id = ? AND user_id = ?');
const ownerStmt = prepare('SELECT user_id FROM steam_links WHERE guild_id = ? AND steam_id = ?');
const saveLinkStmt = prepare(
  `INSERT INTO steam_links (guild_id, user_id, steam_id, linked_at)
   VALUES (@guildId, @userId, @steamId, @now)
   ON CONFLICT (guild_id, user_id) DO UPDATE SET steam_id = @steamId, linked_at = @now`
);
const removeLinkStmt = prepare('DELETE FROM steam_links WHERE guild_id = ? AND user_id = ?');

// One pending stake per member: the NOT EXISTS guard and the insert are one statement.
const insertBetStmt = prepare(
  `INSERT INTO cs2_bets (guild_id, user_id, steam_id, amount, created_at, mode, channel_id, target_id, pick)
   SELECT CAST(@guildId AS TEXT), CAST(@userId AS TEXT), CAST(@steamId AS TEXT),
          CAST(@amount AS BIGINT), CAST(@now AS BIGINT), CAST(@mode AS TEXT), CAST(@channelId AS TEXT),
          CAST(@targetId AS TEXT), CAST(@pick AS TEXT)
   WHERE NOT EXISTS (
     SELECT 1 FROM cs2_bets WHERE guild_id = @guildId AND user_id = @userId AND status = 'pending'
   )`,
  { returningId: true }
);
const pendingStmt = prepare("SELECT * FROM cs2_bets WHERE status = 'pending' ORDER BY id");
const pendingOfUserStmt = prepare(
  "SELECT * FROM cs2_bets WHERE guild_id = ? AND user_id = ? AND status = 'pending'"
);
const settleStmt = prepare(
  `UPDATE cs2_bets SET status = @status, payout = @payout, settled_at = @now
   WHERE id = @id AND status = 'pending'`
);
const recentStmt = prepare(
  'SELECT * FROM cs2_bets WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?'
);

export async function getSteamLink(guildId, userId) {
  return (await getLinkStmt.get(guildId, userId))?.steam_id ?? null;
}

/** Link a SteamID64. Returns 'taken' when another member of the guild already owns it. */
export async function saveSteamLink(guildId, userId, steamId, now = Date.now()) {
  const owner = (await ownerStmt.get(guildId, steamId))?.user_id;
  if (owner && owner !== userId) return 'taken';
  try {
    await saveLinkStmt.run({ guildId, userId, steamId, now });
  } catch (error) {
    // Lost a race against the unique index: somebody linked it a moment ago.
    if ((await ownerStmt.get(guildId, steamId))?.user_id !== userId) return 'taken';
    throw error;
  }
  return 'ok';
}

export async function removeSteamLink(guildId, userId) {
  return (await removeLinkStmt.run(guildId, userId)).changes > 0;
}

/** @returns {Promise<number | null>} the stake id, or null when the member already has a pending one */
export async function insertCs2Bet(
  guildId,
  userId,
  steamId,
  amount,
  mode = 'any',
  channelId = '',
  { targetId = '', pick = 'win' } = {},
  now = Date.now()
) {
  const info = await insertBetStmt.run({
    guildId,
    userId,
    steamId,
    amount,
    mode,
    channelId,
    targetId,
    pick,
    now,
  });
  return info.changes > 0 ? Number(info.lastInsertRowid) : null;
}

export async function pendingCs2Bets() {
  return (await pendingStmt.all()).map(toBet);
}

export async function pendingCs2BetOf(guildId, userId) {
  return toBet(await pendingOfUserStmt.get(guildId, userId));
}

export async function recentCs2Bets(guildId, userId, limit = 5) {
  return (await recentStmt.all(guildId, userId, limit)).map(toBet);
}

/** Close a pending stake. True only for the one caller that wins the race. */
export async function settleCs2Bet(id, status, payout, now = Date.now()) {
  return (await settleStmt.run({ id, status, payout, now })).changes > 0;
}

// Bounded, guild-scoped history for the administration dashboard.
const historyStmt = prepare('SELECT * FROM cs2_bets WHERE guild_id = ? ORDER BY id DESC LIMIT ? OFFSET ?');
export async function cs2BetHistory(guildId, limit = 25, offset = 0) {
  return (await historyStmt.all(guildId, limit, offset)).map(toBet);
}

const activeGuildStmt = prepare(
  "SELECT * FROM cs2_bets WHERE guild_id = ? AND status = 'pending' ORDER BY id DESC LIMIT ? OFFSET ?"
);
export async function activeGuildCs2Bets(guildId, limit = 25, offset = 0) {
  return (await activeGuildStmt.all(guildId, limit, offset)).map(toBet);
}

// The guarded close and credit share a transaction. A competing result or
// refund can win only once; a failed credit rolls back the close as well.
export async function refundCs2Bet(guildId, id, now = Date.now()) {
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  return runAtomicWrites([
    {
      sql: `UPDATE cs2_bets SET status = 'refunded', payout = amount, settled_at = ?
        WHERE guild_id = ? AND id = ? AND status = 'pending'`,
      args: [now, guildId, id],
      requireChanges: true,
    },
    {
      sql: `INSERT INTO economy_accounts (guild_id, user_id, balance)
        SELECT guild_id, user_id, amount FROM cs2_bets WHERE guild_id = ? AND id = ?
        ON CONFLICT (guild_id, user_id) DO UPDATE SET balance = CASE
          WHEN economy_accounts.balance + excluded.balance > ? THEN ?
          ELSE economy_accounts.balance + excluded.balance END`,
      args: [guildId, id, MAX_BALANCE, MAX_BALANCE],
    },
  ]);
}
