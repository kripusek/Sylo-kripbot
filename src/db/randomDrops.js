// Random drops: a posted message with a button. Each member can press it once
// and receives a random line from the drop's list in a DM.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS random_drops (
    id           SERIAL PRIMARY KEY,
    guild_id     TEXT NOT NULL,
    name         TEXT NOT NULL DEFAULT '',
    channel_id   TEXT NOT NULL DEFAULT '',
    message_id   TEXT NOT NULL DEFAULT '',
    text         TEXT NOT NULL DEFAULT '',
    button_label TEXT NOT NULL DEFAULT '',
    pool         TEXT NOT NULL DEFAULT '[]',
    updated_at   BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_random_drops_guild ON random_drops (guild_id, id);
  CREATE TABLE IF NOT EXISTS random_drop_claims (
    drop_id    INTEGER NOT NULL,
    user_id    TEXT NOT NULL,
    guild_id   TEXT NOT NULL,
    result     TEXT NOT NULL DEFAULT '',
    claimed_at BIGINT NOT NULL,
    PRIMARY KEY (drop_id, user_id)
  );
`);

const listStmt = prepare('SELECT * FROM random_drops WHERE guild_id = ? ORDER BY id');
const getStmt = prepare('SELECT * FROM random_drops WHERE id = ?');
const insertStmt = prepare(
  `INSERT INTO random_drops (guild_id, name, channel_id, text, button_label, pool, updated_at)
   VALUES (@guildId, @name, @channelId, @text, @buttonLabel, @pool, @now)`,
  { returningId: true }
);
const updateStmt = prepare(
  `UPDATE random_drops SET name = @name, channel_id = @channelId, text = @text,
     button_label = @buttonLabel, pool = @pool, updated_at = @now
   WHERE id = @id AND guild_id = @guildId`
);
const messageStmt = prepare('UPDATE random_drops SET channel_id = ?, message_id = ? WHERE id = ?');
const claimStmt = prepare(
  `INSERT INTO random_drop_claims (drop_id, user_id, guild_id, result, claimed_at)
   VALUES (@dropId, @userId, @guildId, @result, @now)
   ON CONFLICT (drop_id, user_id) DO NOTHING`
);
const countStmt = prepare('SELECT COUNT(*) AS n FROM random_drop_claims WHERE drop_id = ?');
const delClaims = prepare('DELETE FROM random_drop_claims WHERE drop_id = ? AND guild_id = ?');
const delDrop = prepare('DELETE FROM random_drops WHERE id = ? AND guild_id = ?');

const parse = (row) => {
  if (!row) return null;
  let pool = [];
  try {
    const raw = JSON.parse(row.pool);
    if (Array.isArray(raw)) pool = raw.map(String);
  } catch {
    /* corrupt pool reads as empty */
  }
  return { ...row, pool };
};

export async function listDrops(guildId) {
  const rows = (await listStmt.all(guildId)).map(parse);
  for (const row of rows) row.claims = Number((await countStmt.get(row.id))?.n ?? 0);
  return rows;
}
export const getDrop = async (id) => parse(await getStmt.get(id));

export async function saveDrop(guildId, id, { name, channelId, text, buttonLabel, pool }) {
  const values = { guildId, name, channelId, text, buttonLabel, pool: JSON.stringify(pool), now: Date.now() };
  if (id) {
    await updateStmt.run({ ...values, id });
    return id;
  }
  const info = await insertStmt.run(values);
  return Number(info.lastInsertRowid);
}
export const setDropMessage = (id, channelId, messageId) => messageStmt.run(channelId, messageId, id);

/** Atomically record a click. Resolves true only for the member's first click. */
export async function claimDrop(dropId, userId, guildId, result) {
  const info = await claimStmt.run({ dropId, userId, guildId, result, now: Date.now() });
  return info.changes === 1;
}

export async function deleteDrop(guildId, id) {
  await delClaims.run(id, guildId);
  return (await delDrop.run(id, guildId)).changes === 1;
}
