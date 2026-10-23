// Prediction markets played with the economy's virtual coins.
//
// A market is a question with 2–10 options. Members bet coins on an option;
// when the market resolves, the whole pool is split between the people who bet
// on the winning option in proportion to their stake (parimutuel), so coins are
// only ever moved around — never created. Every state change is one guarded
// statement (status = 'open' in the WHERE clause), so a bet racing a resolution,
// or two resolutions racing each other, can't both win.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS markets (
    id          SERIAL PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    question    TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'custom',
    source_ref  TEXT NOT NULL DEFAULT '',
    options     TEXT NOT NULL DEFAULT '[]',
    status      TEXT NOT NULL DEFAULT 'open',
    winner      INTEGER NOT NULL DEFAULT -1,
    closes_at   BIGINT NOT NULL DEFAULT 0,
    channel_id  TEXT NOT NULL DEFAULT '',
    message_id  TEXT NOT NULL DEFAULT '',
    created_at  BIGINT NOT NULL,
    settled_at  BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_markets_guild ON markets (guild_id, status, id);
  CREATE TABLE IF NOT EXISTS market_bets (
    id         SERIAL PRIMARY KEY,
    market_id  INTEGER NOT NULL,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    option_idx INTEGER NOT NULL,
    amount     BIGINT NOT NULL,
    payout     BIGINT,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_market_bets_market ON market_bets (market_id, option_idx);
  CREATE INDEX IF NOT EXISTS idx_market_bets_user ON market_bets (guild_id, user_id, id);
`);

const num = (v) => Number(v) || 0;
const parseOptions = (json) => {
  try {
    const raw = JSON.parse(json);
    return Array.isArray(raw) ? raw : [];
  } catch {
    return []; // a corrupt list reads as no options
  }
};
const toMarket = (row) =>
  row
    ? {
        id: num(row.id),
        guildId: row.guild_id,
        question: row.question,
        description: row.description,
        source: row.source,
        sourceRef: row.source_ref,
        options: parseOptions(row.options),
        status: row.status,
        winner: num(row.winner),
        closesAt: num(row.closes_at),
        channelId: row.channel_id,
        messageId: row.message_id,
        createdAt: num(row.created_at),
        settledAt: num(row.settled_at),
      }
    : null;

const insertStmt = prepare(
  `INSERT INTO markets (guild_id, question, description, source, source_ref, options, closes_at, created_at)
   VALUES (@guildId, @question, @description, @source, @sourceRef, @options, @closesAt, @now)`,
  { returningId: true }
);
const getStmt = prepare('SELECT * FROM markets WHERE id = ?');
const listStmt = prepare('SELECT * FROM markets WHERE guild_id = ? ORDER BY id DESC LIMIT ?');
const listOpenStmt = prepare(
  "SELECT * FROM markets WHERE guild_id = ? AND status = 'open' ORDER BY id DESC LIMIT ?"
);
const openPolymarketStmt = prepare("SELECT * FROM markets WHERE status = 'open' AND source = 'polymarket'");
const editStmt = prepare(
  `UPDATE markets SET question = @question, description = @description, closes_at = @closesAt
   WHERE id = @id AND guild_id = @guildId AND status = 'open'`
);
const optionsStmt = prepare('UPDATE markets SET options = ? WHERE id = ?');
const messageStmt = prepare('UPDATE markets SET channel_id = ?, message_id = ? WHERE id = ?');
const resolveStmt = prepare(
  `UPDATE markets SET status = 'resolved', winner = @winner, settled_at = @now
   WHERE id = @id AND status = 'open'`
);
const cancelStmt = prepare(
  `UPDATE markets SET status = 'cancelled', winner = -1, settled_at = @now
   WHERE id = @id AND status = 'open'`
);
const deleteMarketStmt = prepare('DELETE FROM markets WHERE id = ? AND guild_id = ?');
const deleteBetsStmt = prepare('DELETE FROM market_bets WHERE market_id = ? AND guild_id = ?');

// The EXISTS guard makes "is the market still open?" and "record the bet" one
// atomic statement. CAST() gives Postgres a type for parameters in a SELECT list.
const betStmt = prepare(
  `INSERT INTO market_bets (market_id, guild_id, user_id, option_idx, amount, created_at)
   SELECT CAST(@marketId AS INTEGER), CAST(@guildId AS TEXT), CAST(@userId AS TEXT),
          CAST(@optionIdx AS INTEGER), CAST(@amount AS BIGINT), CAST(@now AS BIGINT)
   WHERE EXISTS (
     SELECT 1 FROM markets
     WHERE id = @marketId AND guild_id = @guildId AND status = 'open'
       AND (closes_at = 0 OR closes_at > @now)
   )`,
  { returningId: true }
);
const poolsStmt = prepare(
  'SELECT option_idx, SUM(amount) AS total, COUNT(*) AS bets FROM market_bets WHERE market_id = ? GROUP BY option_idx'
);
const betsOfMarketStmt = prepare('SELECT * FROM market_bets WHERE market_id = ? ORDER BY id');
const userBetsStmt = prepare(
  `SELECT b.*, m.question, m.status, m.winner, m.options
   FROM market_bets b JOIN markets m ON m.id = b.market_id
   WHERE b.guild_id = ? AND b.user_id = ? ORDER BY b.id DESC LIMIT ?`
);
const userMarketBetsStmt = prepare(
  'SELECT option_idx, SUM(amount) AS total FROM market_bets WHERE market_id = ? AND user_id = ? GROUP BY option_idx'
);
// A payout is claimed (payout IS NULL -> value) before the coins are credited, so
// a crash can lose one payout but never pay it twice.
const claimPayoutStmt = prepare('UPDATE market_bets SET payout = ? WHERE id = ? AND payout IS NULL');
const leadersStmt = prepare(
  `SELECT user_id, SUM(COALESCE(payout, 0) - amount) AS profit, COUNT(*) AS bets
   FROM market_bets
   WHERE guild_id = ? AND payout IS NOT NULL
   GROUP BY user_id ORDER BY profit DESC, user_id LIMIT ?`
);

export async function insertMarket(guildId, fields, now = Date.now()) {
  const info = await insertStmt.run({
    guildId,
    question: fields.question,
    description: fields.description ?? '',
    source: fields.source ?? 'custom',
    sourceRef: fields.sourceRef ?? '',
    options: JSON.stringify(fields.options),
    closesAt: Math.max(0, Math.floor(fields.closesAt ?? 0)),
    now,
  });
  return Number(info.lastInsertRowid);
}

export async function getMarket(id) {
  return toMarket(await getStmt.get(id));
}

/** A market only if it belongs to `guildId`. */
export async function getGuildMarket(guildId, id) {
  const market = await getMarket(id);
  return market && market.guildId === guildId ? market : null;
}

export async function listMarkets(guildId, { openOnly = false, limit = 100 } = {}) {
  const rows = await (openOnly ? listOpenStmt : listStmt).all(guildId, limit);
  return rows.map(toMarket);
}

/** Every open market imported from Polymarket (all guilds) — for the sync loop. */
export async function openPolymarketMarkets() {
  return (await openPolymarketStmt.all()).map(toMarket);
}

/** Edit the text / closing time of a market that is still open. */
export async function editMarket(guildId, id, { question, description, closesAt }) {
  const info = await editStmt.run({
    id,
    guildId,
    question,
    description: description ?? '',
    closesAt: Math.max(0, Math.floor(closesAt ?? 0)),
  });
  return info.changes > 0;
}

export async function setMarketOptions(id, options) {
  await optionsStmt.run(JSON.stringify(options), id);
}

export async function setMarketMessage(id, channelId, messageId) {
  await messageStmt.run(channelId, messageId, id);
}

/** Flip an open market to resolved. True only for the one caller that wins the race. */
export async function markResolved(id, winner, now = Date.now()) {
  return (await resolveStmt.run({ id, winner, now })).changes > 0;
}

/** Flip an open market to cancelled. True only for the one caller that wins the race. */
export async function markCancelled(id, now = Date.now()) {
  return (await cancelStmt.run({ id, now })).changes > 0;
}

export async function deleteMarket(guildId, id) {
  await deleteBetsStmt.run(id, guildId);
  await deleteMarketStmt.run(id, guildId);
}

/**
 * Record a bet if the market is still open and accepting bets. The coins must
 * already have been debited; the caller refunds when this returns null.
 * @returns {Promise<number | null>} the bet id, or null when the market is closed
 */
export async function recordBet(guildId, marketId, userId, optionIdx, amount, now = Date.now()) {
  const info = await betStmt.run({ guildId, marketId, userId, optionIdx, amount, now });
  return info.changes > 0 ? Number(info.lastInsertRowid) : null;
}

/** Per-option pool totals: `[{ total, bets }]` indexed by option. */
export async function optionPools(marketId, optionCount) {
  const pools = Array.from({ length: optionCount }, () => ({ total: 0, bets: 0 }));
  for (const row of await poolsStmt.all(marketId)) {
    const idx = num(row.option_idx);
    if (pools[idx]) pools[idx] = { total: num(row.total), bets: num(row.bets) };
  }
  return pools;
}

export async function betsOfMarket(marketId) {
  return (await betsOfMarketStmt.all(marketId)).map((r) => ({
    id: num(r.id),
    userId: r.user_id,
    optionIdx: num(r.option_idx),
    amount: num(r.amount),
    payout: r.payout == null ? null : num(r.payout),
  }));
}

/** What one member has staked on each option of a market. */
export async function userStakes(marketId, userId) {
  const out = new Map();
  for (const row of await userMarketBetsStmt.all(marketId, userId))
    out.set(num(row.option_idx), num(row.total));
  return out;
}

export async function userBets(guildId, userId, limit = 15) {
  return (await userBetsStmt.all(guildId, userId, limit)).map((r) => ({
    id: num(r.id),
    marketId: num(r.market_id),
    question: r.question,
    status: r.status,
    winner: num(r.winner),
    options: parseOptions(r.options),
    optionIdx: num(r.option_idx),
    amount: num(r.amount),
    payout: r.payout == null ? null : num(r.payout),
  }));
}

/** Claim one bet's payout slot. True only the first time. */
export async function claimPayout(betId, payout) {
  return (await claimPayoutStmt.run(Math.max(0, Math.floor(payout)), betId)).changes > 0;
}

/** Members with the biggest net profit over all settled bets. */
export async function topPredictors(guildId, limit = 10) {
  return (await leadersStmt.all(guildId, limit)).map((r) => ({
    userId: r.user_id,
    profit: num(r.profit),
    bets: num(r.bets),
  }));
}
