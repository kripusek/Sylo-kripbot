// Legacy history uses a YouTube channel key. New history uses
// '<ytChannel>:<discordChannel>' with a separate video scope, so destinations
// cannot consume each other's notifications during migration. Keep dedup
// history: old uploads remain in feeds even for long-inactive channels.
import { seen, seenValue, seenRow, anySeenMatching, markSeen, forget } from './postedKeys.js';
import { encodeLiveValue, decodeLiveValue } from '../lib/liveValue.js';

const VIDEO = 'yt-video';
const LIVE = 'yt-live';
const INITIALIZED = 'yt-initialized';

const videoScope = (channel) => (channel.includes(':') ? 'yt-video-destination' : VIDEO);
const videoKey = (ytChannel, videoId) => `${ytChannel}:${videoId}`;

export async function hasSeenAny(guildId, ytChannel) {
  // YouTube channel ids are [A-Za-z0-9_-], so the ':' separator makes an
  // index-usable literal prefix.
  return (
    (await seen(guildId, INITIALIZED, ytChannel)) ||
    anySeenMatching(guildId, videoScope(ytChannel), `${ytChannel}:*`)
  );
}
export async function isVideoSeen(guildId, ytChannel, videoId) {
  return seen(guildId, videoScope(ytChannel), videoKey(ytChannel, videoId));
}
export async function markVideoSeen(guildId, ytChannel, videoId) {
  await markSeen(guildId, videoScope(ytChannel), videoKey(ytChannel, videoId));
}
export async function markInitialized(guildId, ytChannel) {
  await markSeen(guildId, INITIALIZED, ytChannel);
}
export async function liveVideoId(guildId, ytChannel) {
  const v = await seenValue(guildId, LIVE, ytChannel);
  return v == null ? null : decodeLiveValue(v).ref;
}
/** The announced live video id + the message we posted, or null. */
export async function livePost(guildId, ytChannel) {
  const row = await seenRow(guildId, LIVE, ytChannel);
  if (!row) return null;
  const { ref, channelId, messageId } = decodeLiveValue(row.value);
  return { videoId: ref, channelId, messageId, postedAt: row.posted_at };
}
/** @param {{ channelId: string, messageId: string } | null} [post] */
export async function markLive(guildId, ytChannel, videoId, post = null) {
  await markSeen(guildId, LIVE, ytChannel, encodeLiveValue(videoId, post?.channelId, post?.messageId), {
    upsert: true,
  });
}
export async function markNotLive(guildId, ytChannel) {
  await forget(guildId, LIVE, ytChannel);
}
