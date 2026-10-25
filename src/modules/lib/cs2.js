// Pure helpers for settling "will I win my next CS2 match?" markets from Leetify
// match data. No network, no database — unit-testable.
//
// Leetify's response fields are only partly documented, so every lookup below
// tolerates a few spellings and the result is `unclear` (never a guess) whenever
// the data doesn't clearly say who won. An unclear match leaves the market open
// for a manual decision.

const STEAM64 = /^7656119\d{10}$/;

/** A SteamID64 from a bare id or a steamcommunity.com/profiles/<id> link; null otherwise (vanity names can't be resolved). */
export function parseSteam64(input) {
  const text = String(input ?? '').trim();
  if (STEAM64.test(text)) return text;
  try {
    const url = new URL(text);
    if (!/(^|\.)steamcommunity\.com$/i.test(url.hostname) && !/(^|\.)leetify\.com$/i.test(url.hostname))
      return null;
    const id = url.pathname.split('/').find((part) => STEAM64.test(part));
    return id ?? null;
  } catch {
    return null;
  }
}

const first = (...values) => values.find((v) => v !== undefined && v !== null);

/** The list of matches out of `/v3/profile/matches`, which may be a bare array or `{ matches: [...] }`. */
export const matchList = (body) =>
  Array.isArray(body) ? body : Array.isArray(body?.matches) ? body.matches : [];

const finishedMs = (match) => {
  const ms = Date.parse(first(match?.finished_at, match?.finishedAt) ?? '');
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The player's result in one match.
 * @returns {{ state: 'win'|'loss'|'tie'|'unclear', map: string, score: string }}
 */
export function evaluateCs2Match(match, steamId) {
  const map = String(first(match?.map_name, match?.mapName) ?? '');
  const scores = (first(match?.team_scores, match?.teamScores) ?? []).map((t) => ({
    team: Number(first(t.team_number, t.teamNumber)),
    score: Number(t.score),
  }));
  const stats = first(match?.stats, match?.player_stats) ?? [];
  const me = stats.find((p) => String(first(p.steam64_id, p.steam64Id, p.steam_id, p.steamId)) === steamId);
  const unclear = { state: 'unclear', map, score: '' };
  if (!me) return unclear;

  const team = Number(first(me.initial_team_number, me.team_number, me.teamNumber, me.team));
  const mine = scores.find((s) => s.team === team);
  const others = scores.filter((s) => s.team !== team);
  let computed = null;
  if (mine && others.length === 1 && Number.isFinite(mine.score) && Number.isFinite(others[0].score)) {
    computed = mine.score > others[0].score ? 'win' : mine.score < others[0].score ? 'loss' : 'tie';
    unclear.score = `${mine.score}:${others[0].score}`;
  }
  const reported = String(first(me.outcome, me.result) ?? '').toLowerCase();
  const stated = ['win', 'loss', 'tie'].includes(reported) ? reported : null;

  if (computed && stated && computed !== stated) return unclear; // sources disagree — don't guess
  const state = computed ?? stated;
  return state ? { state, map, score: unclear.score } : unclear;
}

/** Game modes a CS2 stake can be placed on, with what a win pays. */
export const CS2_MODES = {
  rush: { label: 'Rush', multiplier: 1.5 },
  wingman: { label: 'Wingman', multiplier: 2 },
  competitive: { label: 'Competitive', multiplier: 2.5 },
  premier: { label: 'Premier', multiplier: 3 },
};
/** Stakes placed before modes existed: any match counts, flat 2x. */
export const LEGACY_MODE = { label: 'dowolny', multiplier: 2 };

export const modeInfo = (mode) => CS2_MODES[mode] ?? LEGACY_MODE;

/** The mode-looking fields of a Leetify match, for guessing the mode (and for the log when we can't). */
const modeFields = (match) =>
  [
    'data_source',
    'dataSource',
    'game_mode',
    'gameMode',
    'mode',
    'match_type',
    'matchType',
    'rank_type',
    'rankType',
    'queue',
    'game_type',
  ]
    .map((key) => [key, match?.[key]])
    .filter(([, v]) => typeof v === 'string' && v);

/**
 * Which mode a match was played in, or null when the data doesn't say clearly.
 * Leetify's mode fields aren't fully documented, so this only recognises the
 * mode's own name — it never guesses (plain "matchmaking" could be Premier or
 * Competitive, so it stays unknown).
 */
export function detectMode(match) {
  const text = modeFields(match)
    .map(([, v]) => v.toLowerCase())
    .join(' ');
  const hits = Object.keys(CS2_MODES).filter((mode) => text.includes(mode));
  return hits.length === 1 ? hits[0] : null;
}

/** For logging: the raw mode-ish values of a match. */
export const describeModeFields = (match) =>
  modeFields(match)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ') || '(none)';

/**
 * The first match the player finished after `afterMs`, and what it says.
 * Matches are compared by finish time, oldest first. With `wantedMode`, only
 * matches clearly in that mode count — other modes and matches whose mode can't
 * be told are skipped (`skippedUnknown` counts the latter, for logging).
 * @returns {{ id: string, finishedAt: number, state: string, map: string, score: string } | null} null when none yet
 */
export function firstMatchAfter(matches, steamId, afterMs, wantedMode = null) {
  let skippedUnknown = 0;
  const candidates = matches
    .map((m) => ({ m, at: finishedMs(m) }))
    .filter((x) => x.at !== null && x.at > afterMs)
    .filter(({ m }) => {
      if (!wantedMode || !CS2_MODES[wantedMode]) return true;
      const mode = detectMode(m);
      if (mode === null) skippedUnknown += 1;
      return mode === wantedMode;
    })
    .sort((a, b) => a.at - b.at);
  if (!candidates.length) return skippedUnknown ? { none: true, skippedUnknown } : null;
  const { m, at } = candidates[0];
  return { id: String(first(m.id, m.game_id) ?? ''), finishedAt: at, ...evaluateCs2Match(m, steamId) };
}
