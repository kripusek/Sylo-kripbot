// Honeypot: trap channels and trap messages that punish whoever posts in /
// reacts to them. Any real member interacting with one is an unambiguous
// automation signal (scrapers/raid bots that join, opt into every role, then
// DM the member list) — there is no grace period, only an Administrator/
// immune-role exemption.
//
// config shape (see normaliseHoneypotConfig for the canonical form):
//   {
//     exemptRoles: string[],
//     cleanup: { enabled, minutes },   // also delete the caught member's recent messages
//     logChannelId: string,            // "stupidity" channel: who was caught + what they wrote
//     channels: [ { channelId, action, timeoutMinutes, deleteMessage, triggerCount } ],
//     messages: [ { channelId, messageId, bait, action, timeoutMinutes, triggerCount } ],
//   }
// triggerCount is bot-managed — bumped each time that row actually punishes
// someone, and (for message rows) shown live in the trap message itself,
// e.g. "Bans: 14" — never form-editable.
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { on } from './dispatch.js';
import { getGuildModule, setGuildModule } from '../db/modules.js';
import { postModLog } from '../bot/lib/modlog.js';
import { postToChannel } from './lib/send.js';
import { notifyTarget, MOD_COLOR } from '../bot/lib/moderation.js';
import { addCase } from '../db/modCases.js';
import { recordHoneypotCatch } from '../db/honeypotCatches.js';
import { log } from '../lib/log.js';

export const HONEYPOT_ACTIONS = ['kick', 'timeout', 'ban'];
const ACTION_LABELS = { kick: 'Wyrzucenia', timeout: 'Wyciszenia', ban: 'Bany' };
const MAX_TIMEOUT_MS = 28 * 86_400_000; // Discord's own cap

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const idList = (v) => [...new Set((Array.isArray(v) ? v : [v]).filter((x) => /^\d{17,20}$/.test(x)))];
const isId = (v) => /^\d{17,20}$/.test(v ?? '');
const action = (v) => (HONEYPOT_ACTIONS.includes(v) ? v : 'kick');

export const CLEANUP_MAX_MINUTES = 1440;
const CLEANUP_MAX_CHANNELS = 80; // scan budget per catch
const SWEEP_BATCH = 5; // channels scanned in parallel
const BAN_DELETE_MAX_SECONDS = 7 * 86_400; // Discord's cap for deleteMessageSeconds

export function normaliseHoneypotConfig(raw = {}) {
  return {
    exemptRoles: idList(raw.exemptRoles),
    logChannelId: isId(raw.logChannelId) ? raw.logChannelId : '',
    cleanup: {
      enabled: raw.cleanup?.enabled === true,
      minutes: clampInt(raw.cleanup?.minutes, 1, CLEANUP_MAX_MINUTES, 15),
    },
    channels: (Array.isArray(raw.channels) ? raw.channels : [])
      .map((c) => ({
        channelId: isId(c.channelId) ? c.channelId : '',
        action: action(c.action),
        timeoutMinutes: clampInt(c.timeoutMinutes, 1, 40320, 10),
        deleteMessage: c.deleteMessage !== false,
        triggerCount: clampInt(c.triggerCount, 0, 10_000_000, 0),
      }))
      .filter((c, i, arr) => c.channelId && arr.findIndex((x) => x.channelId === c.channelId) === i)
      .slice(0, 25),
    messages: (Array.isArray(raw.messages) ? raw.messages : [])
      .map((m) => ({
        channelId: isId(m.channelId) ? m.channelId : '',
        messageId: isId(m.messageId) ? m.messageId : '',
        bait: String(m.bait ?? '').slice(0, 500),
        action: action(m.action),
        timeoutMinutes: clampInt(m.timeoutMinutes, 1, 40320, 10),
        triggerCount: clampInt(m.triggerCount, 0, 10_000_000, 0),
      }))
      .filter((m, i, arr) => m.channelId && arr.findIndex((x) => x.channelId === m.channelId) === i)
      .slice(0, 25),
  };
}

function isExempt(member, cfg) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return cfg.exemptRoles.some((r) => member.roles.cache.has(r));
}

// Fetching a message by id (needed to edit the live "Catches" count, and to
// tell "still there" from "deleted, re-post it" apart) needs Read Message
// History on top of the View/Send/Embed set ensureHoneypotMessages already
// checked for — a permission gap here used to be silently swallowed by the
// fetch's .catch(() => null), which then read as "the message was deleted"
// and posted a fresh duplicate on every config save, on top of the visible
// "Catches" count never updating (the exact symptom reported against #211).
const BAIT_PERMS = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'];
function canManageBait(channel, me) {
  return Boolean(channel.permissionsFor(me)?.has(BAIT_PERMS));
}

/** The trap message's embed — a "Catches" field labeled by the row's own
 * punishment action (e.g. "Bans: 14") so it reflects what actually happens
 * here, not a generic counter. */
function baitEmbed(row, cfg = {}) {
  // Each row keeps its own counter; the Discord display combines matching
  // punishments from messages and reactions in the same channel.
  const channelCount = (cfg.channels || [])
    .filter((entry) => entry.channelId === row.channelId && entry.action === row.action)
    .reduce((sum, entry) => sum + (Number(entry.triggerCount) || 0), 0);
  const total = (Number(row.triggerCount) || 0) + channelCount;
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('🍯 Nie pisz ani nie reaguj tutaj')
    .setDescription(row.bait || '​')
    .addFields({
      name: 'Wykryte przypadki',
      value: `${ACTION_LABELS[row.action]}: ${total}`,
    });
}

const EVIDENCE_LINE_MAX = 160;
const EVIDENCE_TOTAL_MAX = 3500;

/** Message text made safe to show in a log: one line, no clickable links or mentions, shortened. */
export function evidenceText(content, attachments = 0) {
  const text = String(content ?? '')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EVIDENCE_LINE_MAX);
  const files = attachments ? ` [+${attachments} zał.]` : '';
  return `\`${text || '(bez tekstu)'}\`${files}`;
}

/**
 * Read (without deleting) a member's messages from the last `minutes` minutes, so
 * the "stupidity" log can show what they wrote before cleanup removes it.
 * @returns {Promise<Array<{ channelId: string, content: string, attachments: number }>>}
 */
export async function collectRecentMessages(guild, userId, minutes, now = Date.now()) {
  const since = now - minutes * 60_000;
  const me = guild.members.me;
  const needed = ['ViewChannel', 'ReadMessageHistory'];
  const channels = [...guild.channels.cache.values()]
    .filter((c) => c.isTextBased?.() && c.messages && c.permissionsFor?.(me)?.has(needed))
    .slice(0, CLEANUP_MAX_CHANNELS);
  const found = [];
  const scan = async (channel) => {
    try {
      const recent = await channel.messages.fetch({ limit: 100 });
      for (const m of recent.values())
        if (m.author?.id === userId && m.createdTimestamp >= since)
          found.push({
            channelId: channel.id,
            at: m.createdTimestamp,
            content: m.content,
            attachments: m.attachments?.size ?? 0,
          });
    } catch (err) {
      log.warn('module:honeypot', `reading ${channel.id} for the log failed: ${err.message}`);
    }
  };
  for (let i = 0; i < channels.length; i += SWEEP_BATCH)
    await Promise.all(channels.slice(i, i + SWEEP_BATCH).map(scan));
  return found.sort((a, b) => a.at - b.at);
}

/** Post the "who was caught and what they wrote" entry to the log channel. */
export async function postCatchLog(guild, channelId, { member, done, reason, trigger, deleted }) {
  if (!channelId) return false;
  const parts = [`${member.user.tag} (\`${member.id}\`) — **${done}**`, reason];
  if (trigger) parts.push(`\n**Napisał na pułapce**\n${evidenceText(trigger.content, trigger.attachments)}`);
  if (deleted.length) {
    const lines = [];
    let used = 0;
    for (const m of deleted) {
      const line = `<#${m.channelId}>: ${evidenceText(m.content, m.attachments)}`;
      if (used + line.length > EVIDENCE_TOTAL_MAX) {
        lines.push(`…i ${deleted.length - lines.length} więcej`);
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    parts.push(`\n**Usunięte wiadomości (${deleted.length})**\n${lines.join('\n')}`);
  }
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('🍯 Złapany na pułapkę')
    .setThumbnail(member.user.displayAvatarURL())
    .setDescription(parts.join('\n').slice(0, 4000))
    .setTimestamp(Date.now());
  return Boolean(
    await postToChannel(guild.id, channelId, { embeds: [embed], allowedMentions: { parse: [] } })
  );
}

/**
 * Delete a member's messages from the last `minutes` minutes in every channel
 * the bot can moderate. Scam bots blast the same message into many channels
 * within seconds, so one sweep over recent history removes the whole burst.
 * Kick/timeout need this; a ban uses Discord's own deleteMessageSeconds.
 * @returns {Promise<number>} how many messages were deleted
 */
export async function sweepRecentMessages(guild, userId, minutes, now = Date.now()) {
  const since = now - minutes * 60_000;
  const me = guild.members.me;
  const needed = ['ViewChannel', 'ReadMessageHistory', 'ManageMessages'];
  const channels = [...guild.channels.cache.values()]
    .filter((c) => c.isTextBased?.() && c.messages && c.permissionsFor?.(me)?.has(needed))
    .slice(0, CLEANUP_MAX_CHANNELS);

  let deleted = 0;
  const sweep = async (channel) => {
    try {
      const recent = await channel.messages.fetch({ limit: 100 });
      const mine = [...recent.values()].filter((m) => m.author?.id === userId && m.createdTimestamp >= since);
      if (!mine.length) return;
      if (mine.length === 1) await mine[0].delete();
      else await channel.bulkDelete(mine, true);
      deleted += mine.length;
    } catch (err) {
      log.warn('module:honeypot', `cleanup in ${channel.id} failed: ${err.message}`);
    }
  };
  for (let i = 0; i < channels.length; i += SWEEP_BATCH) {
    await Promise.all(channels.slice(i, i + SWEEP_BATCH).map(sweep));
  }
  return deleted;
}

/** Apply the configured punishment, log a case, and post to the mod-log.
 * @returns {string|null} a short description of what happened, or null if
 *   nothing was (or could be) done — callers use this to decide whether to
 *   bump the row's trigger count.
 */
async function punish(
  guild,
  member,
  entry,
  reason,
  cleanup = { enabled: false, minutes: 15 },
  catchLog = { channelId: '', trigger: null }
) {
  let done = null;
  let cleaned = null; // message count, or text for a ban
  // Read what they wrote BEFORE it is deleted (a ban removes it at once).
  const deleted =
    catchLog.channelId && cleanup.enabled
      ? await collectRecentMessages(guild, member.id, cleanup.minutes).catch(() => [])
      : [];
  try {
    if (entry.action === 'timeout' && member.moderatable) {
      await member.timeout(Math.min(entry.timeoutMinutes * 60_000, MAX_TIMEOUT_MS), reason);
      done = `Wyciszenie na ${entry.timeoutMinutes} min`;
      await notifyTarget(member.user, { guildName: guild.name, action: 'timed out', reason });
    } else if (entry.action === 'kick' && member.kickable) {
      await notifyTarget(member.user, { guildName: guild.name, action: 'kicked', reason });
      await member.kick(reason);
      done = 'Wyrzucenie';
    } else if (entry.action === 'ban' && guild.members.me?.permissions.has('BanMembers')) {
      await notifyTarget(member.user, { guildName: guild.name, action: 'banned', reason });
      await guild.bans.create(member.id, {
        reason,
        ...(cleanup.enabled
          ? { deleteMessageSeconds: Math.min(cleanup.minutes * 60, BAN_DELETE_MAX_SECONDS) }
          : {}),
      });
      done = 'Ban';
      if (cleanup.enabled) cleaned = `ostatnie ${cleanup.minutes} min (przy banie)`;
    }
  } catch (err) {
    log.error('module:honeypot', 'punish failed:', err.message);
    return null;
  }
  if (!done) return null;

  if (cleanup.enabled && entry.action !== 'ban') {
    cleaned = await sweepRecentMessages(guild, member.id, cleanup.minutes).catch((err) => {
      log.error('module:honeypot', 'cleanup failed:', err.message);
      return null;
    });
  }

  const { caseNumber } = await addCase({
    guildId: guild.id,
    userId: member.id,
    moderatorId: 'honeypot',
    action: entry.action,
    reason,
    detail: entry.action === 'timeout' ? `${entry.timeoutMinutes}m` : null,
  });

  const embed = new EmbedBuilder()
    .setColor(MOD_COLOR)
    .setTitle('Uruchomiono pułapkę')
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'Sprawa', value: `#${caseNumber}` },
      { name: 'Użytkownik', value: `${member.user.tag} (\`${member.id}\`)` },
      { name: 'Kara', value: done },
      { name: 'Powód', value: reason }
    )
    .setTimestamp(Date.now());
  if (cleaned !== null) {
    embed.addFields({
      name: 'Usunięte wiadomości',
      value: typeof cleaned === 'number' ? `${cleaned} (ostatnie ${cleanup.minutes} min)` : cleaned,
    });
  }
  await postModLog(guild, embed);
  if (catchLog.channelId)
    await postCatchLog(guild, catchLog.channelId, {
      member,
      done,
      reason,
      trigger: catchLog.trigger,
      deleted,
    }).catch((err) => log.error('module:honeypot', 'catch log post failed:', err.message));
  return done;
}

/**
 * Bumps a row's triggerCount and persists it — re-reads the config fresh
 * (not the stale copy the dispatch handler was called with) so a rapid
 * back-to-back trigger on the same row doesn't clobber the other's count.
 * Both trigger types re-render the live trap message so the visible
 * "Bans: N" (or Kicks/Timeouts) count is never stale.
 */
const statUpdates = new Map();
async function bumpHoneypotStat(guild, kind, channelId) {
  const previous = statUpdates.get(guild.id) || Promise.resolve();
  const job = previous.catch(() => {}).then(() => bumpHoneypotStatUnlocked(guild, kind, channelId));
  statUpdates.set(guild.id, job);
  try {
    await job;
  } finally {
    if (statUpdates.get(guild.id) === job) statUpdates.delete(guild.id);
  }
}
async function bumpHoneypotStatUnlocked(guild, kind, channelId) {
  const fresh = (await getGuildModule(guild.id, 'honeypot')).config;
  const list = Array.isArray(fresh[kind]) ? fresh[kind] : [];
  const row = list.find((r) => r.channelId === channelId);
  if (!row) return;
  row.triggerCount = (row.triggerCount || 0) + 1;
  await setGuildModule(guild.id, 'honeypot', { config: { ...fresh, [kind]: list } });

  const displayRow = (fresh.messages || []).find((entry) => entry.channelId === channelId);
  if (!displayRow?.messageId) return;
  const channel =
    guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased()) return;
  if (!canManageBait(channel, guild.members.me)) {
    log.warn(
      'module:honeypot',
      `missing permissions (need ${BAIT_PERMS.join(', ')}) to update the live catch count in #${channel.name ?? channelId}`
    );
    return;
  }
  const existing = await channel.messages.fetch(displayRow.messageId).catch((err) => {
    log.error('module:honeypot', 'fetching the bait message failed:', err.message);
    return null;
  });
  if (!existing) return;
  await existing
    .edit({ embeds: [baitEmbed(displayRow, fresh)] })
    .catch((err) => log.error('module:honeypot', 'updating the live catch count failed:', err.message));
}

/**
 * (Re)posts each configured trap message, editing it in place when it
 * already exists — same "bot owns the message, admin only edits the text"
 * pattern verification.js's ensureVerifyMessage uses, generalized to a list
 * of rows keyed by channelId instead of a single row.
 */
export async function ensureHoneypotMessages(guild, config) {
  const rows = Array.isArray(config.messages) ? config.messages : [];
  if (!rows.length) return;
  const me = guild.members.me;
  let changed = false;

  for (const row of rows) {
    if (!row.channelId) continue;
    const channel =
      guild.channels.cache.get(row.channelId) ??
      (await guild.channels.fetch(row.channelId).catch(() => null));
    if (!channel?.isTextBased()) continue;
    if (!canManageBait(channel, me)) {
      log.warn(
        'module:honeypot',
        `missing permissions (need ${BAIT_PERMS.join(', ')}) to manage the bait message in #${channel.name ?? row.channelId}`
      );
      continue;
    }

    if (row.messageId) {
      const existing = await channel.messages.fetch(row.messageId).catch((err) => {
        log.error('module:honeypot', 'fetching the bait message failed:', err.message);
        return null;
      });
      if (existing) {
        await existing
          .edit({ embeds: [baitEmbed(row, config)] })
          .catch((err) => log.error('module:honeypot', 'updating the bait message failed:', err.message));
        continue;
      }
    }
    const posted = await channel.send({ embeds: [baitEmbed(row, config)] }).catch((err) => {
      log.error('module:honeypot', 'posting the bait message failed:', err.message);
      return null;
    });
    if (posted) {
      row.messageId = posted.id;
      changed = true;
    }
  }

  if (changed) {
    const fresh = (await getGuildModule(guild.id, 'honeypot')).config;
    const byChannel = new Map(rows.map((r) => [r.channelId, r]));
    const merged = {
      ...fresh,
      messages: (fresh.messages ?? []).map((m) => byChannel.get(m.channelId) ?? m),
    };
    await setGuildModule(guild.id, 'honeypot', { config: merged });
  }
}

on('honeypot', 'messageCreate', async (message, config) => {
  if (message.partial || !message.guild) return;
  const cfg = normaliseHoneypotConfig(config);
  if (!cfg.channels.length) return;
  const entry = cfg.channels.find((c) => c.channelId === message.channelId);
  if (!entry) return;

  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member || isExempt(member, cfg)) return;

  const done = await punish(
    message.guild,
    member,
    entry,
    'Pułapka: wysłanie wiadomości na kanale pułapce',
    cfg.cleanup,
    {
      channelId: cfg.logChannelId,
      trigger: { content: message.content, attachments: message.attachments?.size ?? 0 },
    }
  );
  if (entry.deleteMessage && message.deletable) await message.delete().catch(() => {});
  if (done) {
    await bumpHoneypotStat(message.guild, 'channels', message.channelId);
    await recordHoneypotCatch(message.guild.id, {
      userId: member.id,
      userTag: member.user.tag,
      kind: 'channel',
      channelId: message.channelId,
      action: entry.action,
    }).catch((err) => log.error('module:honeypot', 'catch log failed:', err.message));
  }
});

on('honeypot', 'reactionAdd', async ({ reaction, user }, config) => {
  if (user.bot) return;
  const cfg = normaliseHoneypotConfig(config);
  if (!cfg.messages.length) return;
  const entry = cfg.messages.find((m) => m.messageId === reaction.message.id);
  if (!entry) return;

  const guild = reaction.message.guild;
  if (!guild) return;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member || isExempt(member, cfg)) return;

  const done = await punish(
    guild,
    member,
    entry,
    'Pułapka: dodanie reakcji do wiadomości pułapki',
    cfg.cleanup,
    { channelId: cfg.logChannelId, trigger: null }
  );
  if (done) {
    await bumpHoneypotStat(guild, 'messages', entry.channelId);
    await recordHoneypotCatch(guild.id, {
      userId: member.id,
      userTag: member.user.tag,
      kind: 'message',
      channelId: entry.channelId,
      action: entry.action,
    }).catch((err) => log.error('module:honeypot', 'catch log failed:', err.message));
  }
});
