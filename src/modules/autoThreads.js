import { ChannelType } from 'discord.js';
import { on } from './dispatch.js';

export const ARCHIVE_MINUTES = [60, 1440, 4320, 10080];
export function normaliseAutoThreads(raw = {}) {
  const values = Array.isArray(raw.channelIds) ? raw.channelIds : [raw.channelIds];
  return {
    channelIds: [...new Set(values.filter((v) => typeof v === 'string' && /^\d{17,20}$/.test(v)))].slice(
      0,
      100
    ),
    nameTemplate:
      String(raw.nameTemplate ?? 'Dyskusja — {author}')
        .trim()
        .slice(0, 100) || 'Dyskusja — {author}',
    autoArchiveDuration: ARCHIVE_MINUTES.includes(Number(raw.autoArchiveDuration))
      ? Number(raw.autoArchiveDuration)
      : 1440,
  };
}
export function threadName(message, template) {
  const author = message.member?.displayName ?? message.author.username ?? 'użytkownik';
  const content = String(message.content ?? '')
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    template
      .replace(/\{(author|message)\}/g, (_, key) => (key === 'author' ? author : content || 'Załącznik'))
      .slice(0, 100)
      .trim() || 'Dyskusja'
  );
}
const pending = new Set();
export async function createAutoThread(message, rawConfig) {
  const cfg = normaliseAutoThreads(rawConfig);
  if (
    !message.guild ||
    message.author?.bot ||
    message.webhookId ||
    message.system ||
    message.hasThread ||
    ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(message.channel.type) ||
    !cfg.channelIds.includes(message.channelId)
  )
    return;
  if (pending.has(message.id)) return;
  const me = message.guild.members.me;
  if (
    !me ||
    !message.channel.permissionsFor(me)?.has(['ViewChannel', 'ReadMessageHistory', 'CreatePublicThreads'])
  )
    return;
  pending.add(message.id);
  try {
    return await message.startThread({
      name: threadName(message, cfg.nameTemplate),
      autoArchiveDuration: cfg.autoArchiveDuration,
      reason: 'Automatyczny wątek na wybranym kanale',
    });
  } finally {
    pending.delete(message.id);
  }
}
on('auto-threads', 'messageCreate', createAutoThread);
