import { punishmentCounts } from '../../db/modCases.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { assignableRoles } from './guildContext.js';

export async function savePunishmentRankingRoles(guild, submitted) {
  const allowed = new Set(assignableRoles(guild).map((role) => role.id));
  const roles = [...new Set((Array.isArray(submitted) ? submitted : []).filter((id) => typeof id === 'string' && allowed.has(id)))];
  await setGuildModule(guild.id, 'punishment-ranking', { config: { roles } });
  return roles;
}

export async function punishmentRanking(guild, filter) {
  const roles = assignableRoles(guild);
  const cfg = (await getGuildModule(guild.id, 'punishment-ranking')).config;
  const selected = Array.isArray(cfg.roles) ? cfg.roles.filter((id) => roles.some((role) => role.id === id)) : [];
  const roleFilter = typeof filter === 'string' && selected.includes(filter) ? filter : '';
  const totals = new Map();
  for (const row of await punishmentCounts(guild.id)) {
    if (!/^\d{17,20}$/.test(row.moderator_id)) continue;
    const entry = totals.get(row.moderator_id) || { id: row.moderator_id, warn: 0, timeout: 0, kick: 0, ban: 0, total: 0 };
    entry[row.action] = Number(row.total);
    entry.total += Number(row.total);
    totals.set(entry.id, entry);
  }
  let lookupErrors = 0;
  const ranking = [];
  if (selected.length) {
    for (const entry of totals.values()) {
      let member;
      try { member = await guild.members.fetch(entry.id); }
      catch (err) { if (err.code !== 10007) lookupErrors++; continue; }
      if (!selected.some((id) => member.roles.cache.has(id))) continue;
      if (roleFilter && !member.roles.cache.has(roleFilter)) continue;
      ranking.push({ ...entry, name: member.displayName });
    }
  }
  ranking.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { roles, selected, roleFilter, ranking, lookupErrors };
}
