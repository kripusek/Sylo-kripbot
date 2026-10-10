import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseYoutubeConfig,
  parseFeed,
  fillMessage,
  resolveYtChannel,
  checkLive,
  parseLivePage,
  runAlert,
} from '../src/modules/youtubeAlerts.js';
import { log } from '../src/lib/log.js';

const UC = 'UC' + 'x'.repeat(22);
const CH = '123456789012345678';

test('normaliseYoutubeConfig: needs a UC id + discord channel, dedupes, caps', () => {
  const c = normaliseYoutubeConfig({
    alerts: [
      { ytChannelId: UC, discordChannelId: CH, name: 'MrBeast', roleId: '999999999999999999', onLive: true },
      { ytChannelId: UC, discordChannelId: CH }, // dupe
      { ytChannelId: 'not-a-uc', discordChannelId: CH }, // dropped
      { ytChannelId: UC, discordChannelId: '' }, // dropped
    ],
  });
  assert.equal(c.alerts.length, 1);
  assert.equal(c.alerts[0].name, 'MrBeast');
  assert.equal(c.alerts[0].onVideo, true); // default
  assert.equal(c.alerts[0].onLive, true);
  assert.equal(c.alerts[0].roleId, '999999999999999999');
});

test('resolveYtChannel: a UC id or youtube.com URL resolves without a fetch', async () => {
  assert.deepEqual(await resolveYtChannel(UC), { channelId: UC, name: '' });
  assert.deepEqual(await resolveYtChannel(`https://www.youtube.com/channel/${UC}`), {
    channelId: UC,
    name: '',
  });
});

test('resolveYtChannel: a non-youtube URL is rejected (SSRF guard), never fetched', async () => {
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return { ok: false };
  };
  try {
    assert.equal(await resolveYtChannel('https://169.254.169.254/latest/meta-data/'), null);
    assert.equal(await resolveYtChannel('http://evil.example/@x'), null);
    assert.equal(await resolveYtChannel('https://youtube.evil.example/@x'), null);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// issue #178: "stopped working, nothing in the logs" — resolveYtChannel and
// checkLive used to swallow every fetch failure completely silently. These
// prove each failure mode now logs something useful, without changing the
// return value callers already depend on.
function withMockedFetch(response, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  const realWarn = log.warn;
  const warnings = [];
  log.warn = (...args) => warnings.push(args);
  return fn(warnings).finally(() => {
    globalThis.fetch = realFetch;
    log.warn = realWarn;
  });
}

test('resolveYtChannel: an HTTP error logs a warning with the status', async () => {
  await withMockedFetch({ ok: false, status: 429 }, async (warnings) => {
    assert.equal(await resolveYtChannel('@somechannel'), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].join(' '), /HTTP 429/);
  });
});

test('resolveYtChannel: a 200 with no recognisable channel id logs a warning', async () => {
  await withMockedFetch(
    { ok: true, text: async () => '<html>no channel id here</html>' },
    async (warnings) => {
      assert.equal(await resolveYtChannel('@somechannel'), null);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0].join(' '), /no channel id found/);
    }
  );
});

test('checkLive: an HTTP error logs a warning and preserves unknown state', async () => {
  await withMockedFetch({ ok: false, status: 503 }, async (warnings) => {
    assert.deepEqual(await checkLive(UC), { live: null });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].join(' '), /HTTP 503/);
  });
});

test('checkLive: legitimately not live is silent (no warning) — the common case', async () => {
  await withMockedFetch(
    { ok: true, text: async () => `<script>{"channelMetadataRenderer":{"externalId":"${UC}"}}</script>` },
    async (warnings) => {
      assert.deepEqual(await checkLive(UC), { live: false });
      assert.equal(warnings.length, 0);
    }
  );
});

// issue #178's actual root cause: YouTube's channel/live pages now run ~2 MB,
// but grab() (shared with the RSS/Atom feed parser) defaulted to a 300 KB scan
// cap sized for feed bodies — so a channelId/videoId sitting past 300 KB was
// silently never found, on an otherwise perfectly healthy 200 response. These
// pad the needle past the old cap and confirm the new one still reaches it.
const PAST_OLD_CAP = 'x'.repeat(350_000); // > the old 300 KB grab() default

test('resolveYtChannel: a channel id past the old 300 KB scan cap is still found', async () => {
  const html = `<html>${PAST_OLD_CAP}<script>{"channelMetadataRenderer":{"externalId":"${UC}"}}</script></html>`;
  await withMockedFetch({ ok: true, text: async () => html }, async (warnings) => {
    assert.deepEqual(await resolveYtChannel('@somechannel'), { channelId: UC, name: '' });
    assert.equal(warnings.length, 0);
  });
});

test('checkLive: a videoId past the old 300 KB scan cap is still found', async () => {
  const html = `<html>${PAST_OLD_CAP}${playerPage()}</html>`;
  await withMockedFetch({ ok: true, text: async () => html }, async (warnings) => {
    assert.deepEqual(await checkLive(UC), { live: true, videoId: 'abcdefghijk', title: 'Actual live title' });
    assert.equal(warnings.length, 0);
  });
});

test('normaliseYoutubeConfig: caps at 50', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    ytChannelId: 'UC' + String(i).padStart(22, '0'),
    discordChannelId: CH,
  }));
  assert.equal(normaliseYoutubeConfig({ alerts: many }).alerts.length, 50);
});

test('parseFeed: pulls entries newest-first with ids, titles, urls', () => {
  const xml = `<?xml version="1.0"?><feed><author><name>Some Channel</name></author>
    <entry><yt:videoId>aaaaaaaaaaa</yt:videoId><title>Older &amp; wiser</title>
      <published>2024-01-01T00:00:00+00:00</published>
      <media:thumbnail url="https://img/a.jpg"/></entry>
    <entry><yt:videoId>bbbbbbbbbbb</yt:videoId><title>Newest</title>
      <published>2024-06-01T00:00:00+00:00</published></entry></feed>`;
  const out = parseFeed(xml);
  assert.deepEqual(
    out.map((e) => e.videoId),
    ['bbbbbbbbbbb', 'aaaaaaaaaaa']
  );
  assert.equal(out[1].title, 'Older & wiser');
  assert.equal(out[0].url, 'https://www.youtube.com/watch?v=bbbbbbbbbbb');
  assert.equal(out[1].thumb, 'https://img/a.jpg');
  assert.match(out[0].thumb, /i\.ytimg\.com/); // fallback thumb
});

test('fillMessage: substitutes and falls back to the default', () => {
  assert.equal(
    fillMessage('{name}: {title} → {url}', 'D', { name: 'Ch', title: 'Vid', url: 'u' }),
    'Ch: Vid → u'
  );
  assert.equal(fillMessage('', 'the default', {}), 'the default');
});

test('failed video delivery is retried and only successful delivery is marked seen', async () => {
  const { runAlert } = await import('../src/modules/youtubeAlerts.js');
  const { markVideoSeen, isVideoSeen } = await import('../src/db/youtubeAlerts.js');
  const { runtime } = await import('../src/runtime.js');
  const guildId = '987654321098765432';
  const channelId = '123456789012345678';
  const videoId = 'abcdefghijk';
  await markVideoSeen(guildId, UC, 'oldvideo123');
  const oldFetch = globalThis.fetch;
  const oldClient = runtime.client;
  globalThis.fetch = async () => ({
    ok: true,
    text: async () =>
      `<feed><entry><yt:videoId>${videoId}</yt:videoId><title>New upload</title><link href="https://www.youtube.com/watch?v=${videoId}"/><published>2026-10-10T20:00:00Z</published></entry></feed>`,
  });
  let fail = true;
  let attempts = 0;
  const channel = {
    isTextBased: () => true,
    send: async () => {
      attempts++;
      if (fail) throw new Error('Missing permissions');
      return { id: 'message' };
    },
  };
  runtime.client = {
    guilds: {
      cache: new Map([[guildId, { members: {}, channels: { cache: new Map([[channelId, channel]]) } }]]),
    },
  };
  const alert = { ytChannelId: UC, discordChannelId: channelId, onVideo: true, onLive: false };
  try {
    await assert.rejects(runAlert(guildId, alert), /will retry/);
    assert.equal(await isVideoSeen(guildId, `${UC}:${channelId}`, videoId), false);
    fail = false;
    await runAlert(guildId, alert);
    assert.equal(await isVideoSeen(guildId, `${UC}:${channelId}`, videoId), true);
    await runAlert(guildId, alert);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = oldFetch;
    runtime.client = oldClient;
  }
});

function playerPage({
  channelId = UC,
  videoId = 'abcdefghijk',
  live = true,
  title = 'Actual live title',
  status = 'OK',
} = {}) {
  return `<script>var ytInitialPlayerResponse = ${JSON.stringify({
    videoDetails: { channelId, videoId, title, isLiveContent: true },
    microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: live } } },
    playabilityStatus: { status },
  })};</script>`;
}

test('live parser ignores recommended livestreams and identifies the actual player owner', () => {
  const recommendation = '"isLive":true,"videoId":"recommend01","title":{"runs":[{"text":"Wrong title"}]}';
  assert.deepEqual(parseLivePage(recommendation + playerPage({ live: false }), UC), { live: false });
  assert.deepEqual(parseLivePage(recommendation + playerPage({ channelId: 'UC' + 'z'.repeat(22) }), UC), {
    live: null,
  });
  assert.deepEqual(parseLivePage(recommendation + playerPage({ title: 'Title "quoted" \u263a' }), UC), {
    live: true,
    videoId: 'abcdefghijk',
    title: 'Title "quoted" \u263a',
  });
  assert.deepEqual(parseLivePage('<html>Consent required</html>', UC), { live: null });
  assert.deepEqual(parseLivePage(playerPage({ status: 'UNPLAYABLE' }), UC), { live: null });
});

test('resolver uses channel metadata rather than a recommended channel', async () => {
  await withMockedFetch(
    {
      ok: true,
      text: async () =>
        `<script>{"channelId":"UC${'z'.repeat(22)}","channelMetadataRenderer":{"externalId":"${UC}","title":"My \\"channel\\""}}</script>`,
    },
    async () => {
      assert.deepEqual(await resolveYtChannel('@real'), { channelId: UC, name: 'My "channel"' });
    }
  );
});

test('empty initial feed is remembered, new uploads reach both destinations, and feed fallback works', async () => {
  const { runtime } = await import('../src/runtime.js');
  const guildId = '876543210987654321';
  const channels = ['123456789012345679', '123456789012345680'];
  const oldFetch = globalThis.fetch,
    oldClient = runtime.client;
  const posts = [];
  let xml = '<feed></feed>',
    requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    if (!url.includes('/xml/feeds/')) return { ok: false, status: 404 };
    return { ok: true, text: async () => xml };
  };
  runtime.client = {
    guilds: {
      cache: new Map([
        [
          guildId,
          {
            members: {},
            channels: {
              cache: new Map(
                channels.map((id) => [
                  id,
                  {
                    isTextBased: () => true,
                    send: async (p) => {
                      posts.push([id, p]);
                      return { id: 'message' };
                    },
                  },
                ])
              ),
            },
          },
        ],
      ]),
    },
  };
  const alerts = channels.map((discordChannelId) => ({
    ytChannelId: UC,
    discordChannelId,
    onVideo: true,
    onLive: false,
  }));
  try {
    let cache = new Map();
    for (const a of alerts) await runAlert(guildId, a, cache);
    assert.equal(posts.length, 0);
    assert.equal(requests, 2);
    xml = '<feed><entry><yt:videoId>newupload01</yt:videoId><title>New</title></entry></feed>';
    cache = new Map();
    for (const a of alerts) await runAlert(guildId, a, cache);
    assert.deepEqual(
      posts.map(([id]) => id),
      channels
    );
    for (const a of alerts) await runAlert(guildId, a);
    assert.equal(posts.length, 2);
  } finally {
    globalThis.fetch = oldFetch;
    runtime.client = oldClient;
  }
});

test('failed live checks preserve the announced message and do not repost after recovery', async () => {
  const { runtime } = await import('../src/runtime.js');
  const { liveVideoId } = await import('../src/db/youtubeAlerts.js');
  const guildId = '765432109876543210';
  const channelId = '123456789012345681';
  const oldFetch = globalThis.fetch,
    oldClient = runtime.client;
  let fail = false,
    posts = 0,
    deletes = 0;
  globalThis.fetch = async () =>
    fail ? { ok: false, status: 503 } : { ok: true, text: async () => playerPage() };
  runtime.client = {
    guilds: {
      cache: new Map([
        [
          guildId,
          {
            members: {},
            channels: {
              cache: new Map([
                [
                  channelId,
                  {
                    isTextBased: () => true,
                    send: async () => {
                      posts++;
                      return { id: '123456789012345682' };
                    },
                    messages: {
                      delete: async () => {
                        deletes++;
                      },
                    },
                  },
                ],
              ]),
            },
          },
        ],
      ]),
    },
  };
  const alert = {
    ytChannelId: UC,
    discordChannelId: channelId,
    onVideo: false,
    onLive: true,
    onEnd: 'delete',
  };
  try {
    await runAlert(guildId, alert);
    fail = true;
    await runAlert(guildId, alert);
    assert.equal(await liveVideoId(guildId, `${UC}:${channelId}`), 'abcdefghijk');
    fail = false;
    await runAlert(guildId, alert);
    assert.equal(posts, 1);
    assert.equal(deletes, 0);
  } finally {
    globalThis.fetch = oldFetch;
    runtime.client = oldClient;
  }
});

test('a feed failure does not stop live delivery, and live entries are not also announced as uploads', async () => {
  const { runtime } = await import('../src/runtime.js');
  const { markInitialized } = await import('../src/db/youtubeAlerts.js');
  const guildId = '654321098765432109',
    channelId = '123456789012345683';
  const oldFetch = globalThis.fetch,
    oldClient = runtime.client;
  let feedFails = true,
    posts = 0;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/live')) return { ok: true, text: async () => playerPage() };
    return feedFails
      ? { ok: false, status: 503 }
      : {
          ok: true,
          text: async () =>
            '<feed><entry><yt:videoId>abcdefghijk</yt:videoId><title>Live</title></entry></feed>',
        };
  };
  runtime.client = {
    guilds: {
      cache: new Map([
        [
          guildId,
          {
            members: {},
            channels: {
              cache: new Map([
                [
                  channelId,
                  {
                    isTextBased: () => true,
                    send: async () => {
                      posts++;
                      return { id: '123456789012345684' };
                    },
                  },
                ],
              ]),
            },
          },
        ],
      ]),
    },
  };
  const alert = { ytChannelId: UC, discordChannelId: channelId, onVideo: true, onLive: true };
  try {
    await markInitialized(guildId, `${UC}:${channelId}`);
    await assert.rejects(runAlert(guildId, alert), /HTTP 503/);
    assert.equal(posts, 1);
    feedFails = false;
    await runAlert(guildId, alert);
    assert.equal(posts, 1);
  } finally {
    globalThis.fetch = oldFetch;
    runtime.client = oldClient;
  }
});

test('multi-destination upload delivery retries only the failed channel and shares its feed fetch', async () => {
  const { runtime } = await import('../src/runtime.js');
  const { markInitialized } = await import('../src/db/youtubeAlerts.js');
  const guildId = '543210987654321098',
    channelIds = ['123456789012345685', '123456789012345686'];
  const oldFetch = globalThis.fetch,
    oldClient = runtime.client;
  let failFirst = true,
    requests = 0;
  const attempts = [0, 0];
  globalThis.fetch = async () => {
    requests++;
    return {
      ok: true,
      text: async () =>
        '<feed><entry><yt:videoId>multivideo1</yt:videoId><title>Multi</title></entry></feed>',
    };
  };
  runtime.client = {
    guilds: {
      cache: new Map([
        [
          guildId,
          {
            members: {},
            channels: {
              cache: new Map(
                channelIds.map((id, i) => [
                  id,
                  {
                    isTextBased: () => true,
                    send: async () => {
                      attempts[i]++;
                      if (i === 0 && failFirst) throw new Error('Missing permissions');
                      return { id: 'message' };
                    },
                  },
                ])
              ),
            },
          },
        ],
      ]),
    },
  };
  const alert = { ytChannelId: UC, discordChannelIds: channelIds, onVideo: true, onLive: false };
  try {
    for (const id of channelIds) await markInitialized(guildId, `${UC}:${id}`);
    await assert.rejects(runAlert(guildId, alert), /will retry/);
    assert.deepEqual(attempts, [1, 1]);
    assert.equal(requests, 1);
    failFirst = false;
    await runAlert(guildId, alert);
    assert.deepEqual(attempts, [2, 1]);
    await runAlert(guildId, alert);
    assert.deepEqual(attempts, [2, 1]);
  } finally {
    globalThis.fetch = oldFetch;
    runtime.client = oldClient;
  }
});
