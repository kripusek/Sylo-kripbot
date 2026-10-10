// YouTube alerts — announce new uploads and "went live" for a channel. No API
// key needed: new videos come from the per-channel Atom feed
// (youtube.com/feeds/videos.xml?channel_id=UC…), live status from a light scrape
// of the channel's /live page.
//
// config shape:
//   { alerts: [ { id, ytChannelId, name, discordChannelId, roleId,
//                 onVideo, onLive, videoMessage, liveMessage } ] }
// message placeholders: {name} {title} {url}
import { EmbedBuilder } from 'discord.js';
import { runtime } from '../runtime.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import {
  hasSeenAny,
  isVideoSeen,
  markVideoSeen,
  liveVideoId,
  livePost,
  markLive,
  markNotLive,
  markInitialized,
} from '../db/youtubeAlerts.js';
import { sendToChannel, postToChannel } from './lib/send.js';
import { settleEndedPost } from './lib/liveAlerts.js';
import { normaliseOnEnd } from '../lib/liveValue.js';
import { parseFeed as parseGenericFeed, grab, decodeEntities } from '../bot/lib/feed.js';
import { log } from '../lib/log.js';

const FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const COLOR = 0xff0000;
const POLL_MS = 3 * 60_000;
const UA = 'Mozilla/5.0 (compatible; Sylo-Discord-Bot/1.0; +https://github.com/Ferdinand99/Sylo)';

// feed.js's grab() defaults to a 300 KB scan cap, sized for RSS/Atom feed
// bodies. resolveYtChannel/checkLive scrape full YouTube HTML pages instead —
// now routinely ~2 MB — and the channelId/videoId/title JSON blobs they need
// sit well past 300 KB, so every grab() below silently came back empty no
// matter how healthy the fetch was (issue #178: "stopped working, nothing in
// the logs" — the fetch succeeded and there genuinely was nothing logged,
// because grab() never got far enough into the page to fail loudly). 3 MB
// covers today's page size with real headroom; still bounded so a change in
// how YouTube serves these pages can't turn a scan into unbounded work.
const PAGE_MAX_SCAN = 3_000_000;
const grabPage = (re, html) => grab(re, html, PAGE_MAX_SCAN);

export const DEFAULT_VIDEO_MESSAGE = '📺 **{name}** opublikował nowy film: **{title}**\n{url}';
export const DEFAULT_LIVE_MESSAGE = '🔴 **{name}** nadaje na żywo na YouTube: **{title}**\n{url}';
const UC_RE = /^UC[\w-]{22}$/;
const isId = (v) => /^\d{17,20}$/.test(v ?? '');

export function normaliseYoutubeConfig(raw = {}) {
  const seen = new Set();
  return {
    alerts: (Array.isArray(raw.alerts) ? raw.alerts : [])
      .filter((a) => a && typeof a === 'object')
      .map((a, i) => ({
        id: a.id ? String(a.id) : String(i),
        ytChannelId: UC_RE.test(a.ytChannelId ?? '') ? a.ytChannelId : '',
        name: String(a.name ?? '').slice(0, 100),
        discordChannelId: isId(a.discordChannelId) ? a.discordChannelId : '',
        discordChannelIds: [
          ...new Set(
            (Array.isArray(a.discordChannelIds) ? a.discordChannelIds : [a.discordChannelId]).filter(isId)
          ),
        ].slice(0, 50),
        roleId: isId(a.roleId) ? a.roleId : '',
        onVideo: a.onVideo !== false,
        onLive: Boolean(a.onLive),
        onEnd: normaliseOnEnd(a.onEnd),
        videoMessage: String(a.videoMessage ?? '').slice(0, 1500),
        liveMessage: String(a.liveMessage ?? '').slice(0, 1500),
      }))
      .filter((a) => {
        if (!a.ytChannelId) return false;
        a.discordChannelIds = a.discordChannelIds.filter((id) => {
          const key = `${a.ytChannelId}:${id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        a.discordChannelId = a.discordChannelIds[0] || '';
        return a.discordChannelIds.length > 0;
      })
      .slice(0, 50),
  };
}

/** Validate dashboard input before normalization can discard incomplete/duplicate rows. */
export function youtubeAlertsValidationError(alerts) {
  if (alerts.length > 50) return 'Możesz dodać maksymalnie 50 powiadomień YouTube.';
  const seen = new Set();
  for (const [index, alert] of alerts.entries()) {
    const ids = Array.isArray(alert.discordChannelIds) ? alert.discordChannelIds : [alert.discordChannelId];
    if (!ids.length || ids.some((id) => !isId(id)))
      return `Powiadomienie ${index + 1}: wybierz kanał Discorda, na który bot ma wysyłać ogłoszenia.`;
    if (ids.length > 50) return `Powiadomienie ${index + 1}: możesz wybrać maksymalnie 50 kanałów Discorda.`;
    if (!UC_RE.test(alert.ytChannelId ?? ''))
      return `Powiadomienie ${index + 1}: nieprawidłowy identyfikator kanału YouTube.`;
    for (const id of new Set(ids)) {
      const key = `${alert.ytChannelId}:${id}`;
      if (seen.has(key))
        return `Powiadomienie ${index + 1}: ten kanał YouTube ma już powiadomienie na wybranym kanale Discorda. Zmień kanał docelowy lub edytuj istniejący wpis.`;
      seen.add(key);
    }
  }
  return null;
}

// --- resolve a URL / @handle / UC id to a channel id + name --------------

/** @returns {Promise<{ channelId: string, name: string } | null>} */
export async function resolveYtChannel(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (UC_RE.test(raw)) return { channelId: raw, name: '' };

  let path;
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'youtube.com' && host !== 'm.youtube.com') return null;
    const direct = /^\/channel\/(UC[\w-]{22})(?:\/|$)/.exec(parsed.pathname);
    if (direct) return { channelId: direct[1], name: '' };
    if (
      !/^\/(?:@[^/]+|c\/[^/]+|user\/[^/]+)(?:\/(?:videos|streams|shorts|featured))?\/?$/.test(parsed.pathname)
    )
      return null;
    path = parsed.pathname;
  } else {
    if (/\s/.test(raw)) return null;
    path = `/@${encodeURIComponent(raw.replace(/^@/, ''))}`;
  }
  // Only a plain channel path — no protocol-relative "//host", no control chars.
  if (!/^\/[A-Za-z0-9@%._~/?=&+-]{1,200}$/.test(path) || path.startsWith('//')) return null;

  // resolveYtChannel/checkLive are the only two scraping-based (not
  // official-API) pieces in this codebase's alert modules — the fragile
  // part, since a YouTube-side page change or IP-based rate limit/challenge
  // breaks them with no client-visible error at all, just "nothing happens".
  // Every return-null path below logs *why*, distinctly, so a report like
  // "it stopped working, nothing in the logs" (issue #178) is diagnosable
  // instead of a dead end — previously all three were silent.
  try {
    const res = await fetch(`https://www.youtube.com${path}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn('youtube-alerts', `resolve ${path}: HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();
    const metadata = pageObject(html, /"channelMetadataRenderer"\s*:/g);
    const channelId =
      metadata?.externalId ||
      grabPage(/<meta\s+itemprop="channelId"\s+content="(UC[\w-]{22})"/, html) ||
      grabPage(/<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/, html);
    if (!UC_RE.test(channelId ?? '')) {
      log.warn(
        'youtube-alerts',
        `resolve ${path}: no channel id found in the response (${html.length} bytes) — YouTube may have changed its page format, or served a consent/challenge page`
      );
      return null;
    }
    const name = metadata?.title || grabPage(/<meta property="og:title" content="([^"]+)">/, html) || '';
    return { channelId, name: decodeEntities(name).slice(0, 100) };
  } catch (err) {
    log.warn('youtube-alerts', `resolve ${path}: ${err.message}`);
    return null;
  }
}

// --- feed (new videos) -------------------------------------------------

/**
 * Parse a YouTube Atom feed into recent entries, newest first. Uses the shared
 * feed parser and maps it onto the YouTube-specific shape (videoId, watch URL,
 * ytimg thumbnail fallback).
 */
export function parseFeed(xml) {
  return parseGenericFeed(xml)
    .map((e) => {
      const videoId = grab(/<yt:videoId>([^<]+)<\/yt:videoId>/, e.block) || grab(/[?&]v=([\w-]{11})/, e.link);
      if (!/^[\w-]{11}$/.test(videoId)) return null;
      return {
        videoId,
        title: e.title === 'Untitled' ? 'New video' : e.title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        published: e.published,
        thumb: e.image || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        author: e.author,
      };
    })
    .filter(Boolean);
}

// Read a JSON object without evaluating scripts or matching unrelated recommended videos.
function pageObject(html, pattern) {
  const text = html.slice(0, PAGE_MAX_SCAN);
  const match = pattern.exec(text);
  if (!match) return null;
  let start = match.index + match[0].length;
  while (/\s/.test(text[start] ?? '') && start < text.length) start++;
  if (text[start] !== '{') return null;
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function fetchFeed(ytChannelId) {
  // YouTube occasionally serves only one of these public feed paths.
  let error;
  for (const base of [FEED, 'https://www.youtube.com/xml/feeds/videos.xml?channel_id=']) {
    try {
      const res = await fetch(base + ytChannelId, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`YT feed HTTP ${res.status}`);
      const xml = await res.text();
      if (!/<feed(?:\s|>)/.test(xml) || !/<\/feed\s*>/.test(xml))
        throw new Error('YT returned an invalid Atom feed');
      return parseFeed(xml);
    } catch (err) {
      error = err;
    }
  }
  throw error;
}

/** null means unknown: a network/challenge response must never end an active stream. */
export function parseLivePage(html, ytChannelId) {
  const player = pageObject(html, /(?:var\s+)?ytInitialPlayerResponse\s*=\s*/g);
  const details = player?.videoDetails;
  const broadcast = player?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
  if (details?.channelId === ytChannelId && /^[\w-]{11}$/.test(details.videoId ?? '')) {
    if (broadcast?.isLiveNow === true && player.playabilityStatus?.status === 'OK') {
      return { live: true, videoId: details.videoId, title: String(details.title || 'Transmisja na żywo') };
    }
    // Upcoming and archived broadcasts are not currently live.
    if (broadcast?.isLiveNow === false || details.isUpcoming === true || details.isLiveContent === false)
      return { live: false };
    return { live: null };
  }
  const metadata = pageObject(html, /"channelMetadataRenderer"\s*:/g);
  if (!player && metadata?.externalId === ytChannelId) return { live: false };
  return { live: null };
}

export async function checkLive(ytChannelId) {
  try {
    const res = await fetch(`https://www.youtube.com/channel/${ytChannelId}/live`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const state = parseLivePage(await res.text(), ytChannelId);
    if (state.live === null)
      log.warn(
        'youtube-alerts',
        `live check ${ytChannelId}: unrecognised player/channel response; preserving previous state`
      );
    return state;
  } catch (err) {
    log.warn('youtube-alerts', `live check ${ytChannelId}: ${err.message}`);
    return { live: null };
  }
}

// --- rendering ----------------------------------------------------------

export function fillMessage(tpl, dflt, { name, title, url }) {
  return String(tpl || dflt)
    .replaceAll('{name}', name ?? '')
    .replaceAll('{title}', title ?? '')
    .replaceAll('{url}', url ?? '');
}

function payload(alert, { name, title, url, thumb }, kind) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: kind === 'live' ? `${name} nadaje na żywo na YouTube` : `${name} · nowy film` })
    .setTitle(title.slice(0, 256))
    .setURL(url)
    .setTimestamp(Date.now());
  if (thumb) embed.setImage(thumb);

  const content = fillMessage(
    kind === 'live' ? alert.liveMessage : alert.videoMessage,
    kind === 'live' ? DEFAULT_LIVE_MESSAGE : DEFAULT_VIDEO_MESSAGE,
    { name, title, url }
  ).trim();

  return {
    content: `${alert.roleId ? `<@&${alert.roleId}> ` : ''}${content}`.trim().slice(0, 2000) || undefined,
    embeds: [embed],
    allowedMentions: { parse: [], roles: alert.roleId ? [alert.roleId] : [] },
  };
}

// --- poll loop -----------------------------------------------------

let polling = false;
async function tick() {
  if (polling) return;
  polling = true;
  try {
    if (!runtime.client?.isReady()) return;
    const requests = new Map();

    for (const guild of runtime.client.guilds.cache.values()) {
      if (!(await isModuleEnabled(guild.id, 'youtube-alerts'))) continue;
      const cfg = normaliseYoutubeConfig((await getGuildModule(guild.id, 'youtube-alerts')).config);
      for (const alert of cfg.alerts) {
        try {
          await runAlert(guild.id, alert, requests);
        } catch (err) {
          log.error('youtube-alerts', `${alert.ytChannelId}:`, err.message);
        }
      }
    }
  } finally {
    polling = false;
  }
}

function once(requests, key, load) {
  if (!requests.has(key)) requests.set(key, load());
  return requests.get(key);
}

export async function runAlert(guildId, alert, requests = new Map()) {
  const destinations = [
    ...new Set(Array.isArray(alert.discordChannelIds) ? alert.discordChannelIds : [alert.discordChannelId]),
  ].filter(isId);
  const errors = [];
  for (const discordChannelId of destinations) {
    try {
      await runDestination(guildId, { ...alert, discordChannelId }, requests);
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

async function runDestination(guildId, alert, requests) {
  const yt = alert.ytChannelId;
  const c = `${yt}:${alert.discordChannelId}`;
  const errors = [];
  const state = alert.onLive ? await once(requests, `live:${yt}`, () => checkLive(yt)) : null;

  if (alert.onVideo) {
    try {
      const entries = await once(requests, `feed:${yt}`, () => fetchFeed(yt));
      if (!(await hasSeenAny(guildId, c))) {
        // First poll for this channel — seed everything without alerting.
        const legacy = await hasSeenAny(guildId, yt);
        for (const e of entries) {
          if (!legacy || (await isVideoSeen(guildId, yt, e.videoId)))
            await markVideoSeen(guildId, c, e.videoId);
        }
        await markInitialized(guildId, c);
        log.info(
          'youtube-alerts',
          `${yt} → ${alert.discordChannelId}: initial feed recorded; historical uploads will not be announced`
        );
      }
      {
        // Alert oldest-first for anything new.
        for (const e of [...entries].reverse()) {
          if (await isVideoSeen(guildId, c, e.videoId)) continue;
          if (state?.live === true && e.videoId === state.videoId) continue;
          const name = alert.name || e.author || 'Kanał YouTube';
          const delivered = await sendToChannel(
            guildId,
            alert.discordChannelId,
            payload(alert, { name, title: e.title, url: e.url, thumb: e.thumb }, 'video')
          );
          if (!delivered)
            throw new Error(
              `Could not send video alert to Discord channel ${alert.discordChannelId}; will retry on the next poll`
            );
          await markVideoSeen(guildId, c, e.videoId);
        }
      }
    } catch (err) {
      errors.push(err);
    }
  }

  if (alert.onLive) {
    try {
      let known = await liveVideoId(guildId, c);
      if (!known) {
        const legacy = await livePost(guildId, yt);
        if (legacy?.channelId === alert.discordChannelId) {
          await markLive(guildId, c, legacy.videoId, legacy);
          known = legacy.videoId;
          await markNotLive(guildId, yt);
        }
      }
      if (state.live && state.videoId !== known) {
        const name = alert.name || 'Kanał YouTube';
        const url = `https://www.youtube.com/watch?v=${state.videoId}`;
        const posted = await postToChannel(
          guildId,
          alert.discordChannelId,
          payload(
            alert,
            {
              name,
              title: state.title || 'Transmisja na żywo',
              url,
              thumb: `https://i.ytimg.com/vi/${state.videoId}/hqdefault.jpg`,
            },
            'live'
          )
        );
        if (!posted)
          throw new Error(
            `Could not send live alert to Discord channel ${alert.discordChannelId}; will retry on the next poll`
          );
        await markVideoSeen(guildId, c, state.videoId);
        await markLive(guildId, c, state.videoId, posted);
      } else if (state.live === false && known) {
        const post = await livePost(guildId, c);
        await markNotLive(guildId, c);
        await settleEndedPost({
          guildId,
          onEnd: alert.onEnd,
          post,
          name: alert.name || 'Kanał YouTube',
          url: post?.videoId ? `https://www.youtube.com/watch?v=${post.videoId}` : undefined,
        });
      }
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length) throw new Error(errors.map((err) => err.message).join('; '));
}

const timer = setInterval(() => {
  tick().catch((err) => log.error('youtube-alerts', 'tick failed:', err.message));
}, POLL_MS);
timer.unref();
setTimeout(
  () => tick().catch((err) => log.error('youtube-alerts', 'startup check failed:', err.message)),
  40_000
).unref();
