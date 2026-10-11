// Applies the dashboard-configured presence (status + activity) to the client.
import { ActivityType } from 'discord.js';
import { getPresenceConfig } from '../../db/appSettings.js';
import { log } from '../../lib/log.js';

const TYPE_MAP = {
  Playing: ActivityType.Playing,
  Listening: ActivityType.Listening,
  Watching: ActivityType.Watching,
  Competing: ActivityType.Competing,
  Custom: ActivityType.Custom,
};

/** Substitute {servers} / {members} in the activity text. */
export function fillPresenceText(text, client) {
  const servers = client.guilds.cache.size;
  const members = [...client.guilds.cache.values()].reduce((sum, g) => sum + (g.memberCount ?? 0), 0);
  return String(text ?? '')
    .replaceAll('{servers}', String(servers))
    .replaceAll('{members}', String(members));
}

const rotations = new WeakMap();

/** Read the stored presence config and push it to Discord. Never throws. */
export async function applyPresence(client, { force = true, now = Date.now(), random = Math.random } = {}) {
  if (!client?.user) return;
  try {
    const cfg = await getPresenceConfig();
    const signature = JSON.stringify(cfg);
    const previous = rotations.get(client);
    if (!force && previous?.signature === signature && now < previous.nextAt) return;
    // Avoid showing the same line twice in a row when multiple texts exist.
    const choices = cfg.texts.length ? cfg.texts : [cfg.text];
    const candidates = choices.length > 1 ? choices.filter((text) => text !== previous?.text) : choices;
    const chosen = candidates[Math.floor(random() * candidates.length)];
    const type = TYPE_MAP[cfg.type] ?? ActivityType.Custom;
    const text = fillPresenceText(chosen, client).trim().slice(0, 128);

    const activities = text
      ? [type === ActivityType.Custom ? { name: 'custom', type, state: text } : { name: text, type }]
      : [];

    client.user.setPresence({ status: cfg.status, activities });
    rotations.set(client, { signature, text: chosen, nextAt: now + cfg.rotationSeconds * 1000 });
  } catch (err) {
    log.error('bot', 'Failed to apply presence:', err.message);
  }
}
