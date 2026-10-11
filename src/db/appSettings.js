// Bot-wide key/value settings (not per guild).
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  );
`);

const getStmt = prepare('SELECT value FROM app_settings WHERE key = ?');
const setStmt = prepare(`
  INSERT INTO app_settings (key, value, updated_at) VALUES (@key, @value, @updatedAt)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

export async function getAppSetting(key) {
  return (await getStmt.get(key))?.value ?? null;
}

export async function setAppSetting(key, value) {
  await setStmt.run({ key, value: String(value), updatedAt: Date.now() });
}

// --- presence / activity --------------------------------------------------

export const PRESENCE_TYPES = ['Playing', 'Listening', 'Watching', 'Competing', 'Custom'];
export const PRESENCE_STATUSES = ['online', 'idle', 'dnd', 'invisible'];

const DEFAULT_PRESENCE = {
  status: 'online',
  type: 'Listening',
  text: '/stats battlefield',
  texts: [],
  rotationSeconds: 60,
};

function rotationConfig(p) {
  const texts = Array.isArray(p.texts) ? p.texts : String(p.texts ?? '').split(/\r?\n/);
  const seconds = Number(p.rotationSeconds);
  return {
    texts: [...new Set(texts.map((text) => String(text).trim().slice(0, 128)).filter(Boolean))].slice(0, 100),
    rotationSeconds: Number.isFinite(seconds) ? Math.max(30, Math.min(3600, Math.floor(seconds))) : 60,
  };
}

/** @returns {Promise<{ status: string, type: string, text: string }>} */
export async function getPresenceConfig() {
  try {
    const raw = await getAppSetting('presence');
    if (!raw) return { ...DEFAULT_PRESENCE };
    const p = JSON.parse(raw);
    return {
      status: PRESENCE_STATUSES.includes(p.status) ? p.status : DEFAULT_PRESENCE.status,
      type: PRESENCE_TYPES.includes(p.type) ? p.type : DEFAULT_PRESENCE.type,
      text: String(p.text ?? '').slice(0, 128),
      ...rotationConfig(p),
    };
  } catch {
    return { ...DEFAULT_PRESENCE };
  }
}

export async function setPresenceConfig({ status, type, text, texts, rotationSeconds }) {
  const value = {
    status: PRESENCE_STATUSES.includes(status) ? status : 'online',
    type: PRESENCE_TYPES.includes(type) ? type : 'Custom',
    text: String(text ?? '').slice(0, 128),
    ...rotationConfig({ texts, rotationSeconds }),
  };
  await setAppSetting('presence', JSON.stringify(value));
  return value;
}
