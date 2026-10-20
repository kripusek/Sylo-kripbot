// Storage for the dashboard DM inbox: conversations an admin started with a
// member from the bot, and the replies that member sends back. Replies are only
// stored for members who already have a thread, so the bot never logs DMs from
// strangers.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS dm_threads (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    last_at  BIGINT NOT NULL,
    unread   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_dm_threads_user ON dm_threads (user_id, last_at DESC);
  CREATE TABLE IF NOT EXISTS dm_messages (
    id         SERIAL PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    direction  TEXT NOT NULL,
    author     TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dm_messages_thread ON dm_messages (guild_id, user_id, id);
`);

const upsertThread = prepare(`
  INSERT INTO dm_threads (guild_id, user_id, last_at, unread)
  VALUES (@guildId, @userId, @now, @unread)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    last_at = @now,
    unread = CASE WHEN @unread > 0 THEN dm_threads.unread + @unread ELSE dm_threads.unread END
`);
const insertMessage = prepare(
  `INSERT INTO dm_messages (guild_id, user_id, direction, author, content, created_at)
   VALUES (@guildId, @userId, @direction, @author, @content, @now)`,
  { returningId: true }
);
const threadsStmt = prepare(
  'SELECT user_id, last_at, unread FROM dm_threads WHERE guild_id = ? ORDER BY last_at DESC LIMIT 100'
);
const messagesStmt = prepare(
  `SELECT id, direction, author, content, created_at FROM dm_messages
   WHERE guild_id = ? AND user_id = ? AND id > ? ORDER BY id DESC LIMIT 200`
);
const readStmt = prepare('UPDATE dm_threads SET unread = 0 WHERE guild_id = ? AND user_id = ?');
const latestGuildStmt = prepare(
  'SELECT guild_id FROM dm_threads WHERE user_id = ? ORDER BY last_at DESC LIMIT 1'
);
const hasThreadStmt = prepare('SELECT 1 AS ok FROM dm_threads WHERE guild_id = ? AND user_id = ?');
const unreadStmt = prepare('SELECT COALESCE(SUM(unread), 0) AS n FROM dm_threads WHERE guild_id = ?');
const delMessages = prepare('DELETE FROM dm_messages WHERE guild_id = ? AND user_id = ?');
const delThread = prepare('DELETE FROM dm_threads WHERE guild_id = ? AND user_id = ?');

/** Store one message and bump the thread. direction: 'out' (admin → member) or 'in' (reply). */
export async function addDmMessage({ guildId, userId, direction, author = '', content }) {
  const now = Date.now();
  await upsertThread.run({ guildId, userId, now, unread: direction === 'in' ? 1 : 0 });
  const info = await insertMessage.run({
    guildId,
    userId,
    direction,
    author: String(author).slice(0, 100),
    content: String(content).slice(0, 4000),
    now,
  });
  return { id: Number(info.lastInsertRowid), direction, author, content, created_at: now };
}

export async function listDmThreads(guildId) {
  return threadsStmt.all(guildId);
}

/** Messages newer than `afterId`, oldest first. */
export async function listDmMessages(guildId, userId, afterId = 0) {
  return (await messagesStmt.all(guildId, userId, Math.max(0, Number(afterId) || 0))).reverse();
}

export const markDmRead = (guildId, userId) => readStmt.run(guildId, userId);
export const dmThreadExists = async (guildId, userId) => Boolean(await hasThreadStmt.get(guildId, userId));
export const latestDmGuild = async (userId) => (await latestGuildStmt.get(userId))?.guild_id ?? null;
export const dmUnreadCount = async (guildId) => Number((await unreadStmt.get(guildId))?.n ?? 0);

export async function deleteDmThread(guildId, userId) {
  await delMessages.run(guildId, userId);
  await delThread.run(guildId, userId);
}
