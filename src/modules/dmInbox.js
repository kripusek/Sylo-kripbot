// DM inbox: an admin can message a server member from the bot (via the
// dashboard) and read what they reply. Not a toggleable module — it only ever
// acts on explicit dashboard sends, and stores replies only from members who
// already have a conversation.
import { addDmMessage, latestDmGuild } from '../db/dmInbox.js';

export const DM_MAX_LENGTH = 2000;

export class DmInboxError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Send a DM to a member of `guild` and record it.
 * @param {import('discord.js').Guild} guild
 */
export async function sendDirectMessage(guild, userId, content, actor = 'dashboard') {
  const text = String(content ?? '').trim();
  if (!/^\d{17,20}$/.test(userId ?? '')) throw new DmInboxError('Nieprawidłowe ID użytkownika.');
  if (!text) throw new DmInboxError('Wpisz treść wiadomości.');
  if (text.length > DM_MAX_LENGTH)
    throw new DmInboxError(`Wiadomość może mieć maks. ${DM_MAX_LENGTH} znaków.`);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) throw new DmInboxError('Ten użytkownik nie jest na tym serwerze.', 404);
  if (member.user.bot) throw new DmInboxError('Nie można wysłać wiadomości do bota.');
  try {
    await member.user.send({ content: text, allowedMentions: { parse: [] } });
  } catch {
    throw new DmInboxError('Nie udało się wysłać. Użytkownik ma zablokowane wiadomości prywatne.', 422);
  }
  return addDmMessage({ guildId: guild.id, userId, direction: 'out', author: actor, content: text });
}

/** Record a reply sent to the bot in DMs, if that member has a conversation. */
export async function recordIncomingDm(message) {
  if (message.guildId || message.author?.bot) return false;
  const guildId = await latestDmGuild(message.author.id);
  if (!guildId) return false;
  if (message.partial) await message.fetch().catch(() => null);
  const attachments = [...(message.attachments?.values?.() ?? [])].map((a) => a.url);
  const content = [message.content, ...attachments].filter(Boolean).join('\n');
  if (!content) return false;
  await addDmMessage({
    guildId,
    userId: message.author.id,
    direction: 'in',
    author: message.author.username,
    content,
  });
  return true;
}
