import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import prism from 'prism-media';
import { ChannelType } from 'discord.js';
import { PcmMixer, MixerPlayback, FRAME_BYTES } from '../src/modules/lib/pcmMixer.js';
import { createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus } from '@discordjs/voice';
import { relayActive } from '../src/modules/lib/relayState.js';
import {
  normaliseVoiceRelay,
  startRelay,
  relays,
  relayStatus,
  relayInviteUrl,
  RelayError,
} from '../src/modules/voiceRelay.js';

const G = '111111111111111111';
const IN = '222222222222222221';
const OUT = '222222222222222222';
const HUMAN = '333333333333333331';
const HUMAN2 = '333333333333333332';
const BOT = '333333333333333399';

// ---------------------------------------------------------------- config ----

test('normaliseVoiceRelay: ids validated, everything off by default except the notice', () => {
  assert.deepEqual(normaliseVoiceRelay({}), {
    inputChannelId: '',
    outputChannelId: '',
    twoWay: false,
    active: false,
    announce: true,
  });
  const c = normaliseVoiceRelay({ inputChannelId: IN, outputChannelId: 'nope', twoWay: 'on', active: true });
  assert.equal(c.inputChannelId, IN);
  assert.equal(c.outputChannelId, '');
  assert.equal(c.twoWay, false); // only a real boolean counts
  assert.equal(c.active, true);
  assert.equal(normaliseVoiceRelay({ announce: false }).announce, false);
});

// ----------------------------------------------------------------- mixer ----

const frame = (value) => {
  const b = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i += 2) b.writeInt16LE(value, i);
  return b;
};
const sample = (buf, i = 0) => buf.readInt16LE(i * 2);

test('PcmMixer: sums speakers, clips to 16-bit and stays silent when nobody talks', () => {
  const m = new PcmMixer({ prebufferFrames: 1 });
  assert.equal(m.mix(), null);
  m.write('a', frame(1000));
  m.write('b', frame(-300));
  assert.equal(sample(m.mix()), 700);
  assert.equal(m.mix(), null);

  m.write('a', frame(30000));
  m.write('b', frame(30000));
  assert.equal(sample(m.mix()), 32767); // clipped, not wrapped
  m.write('a', frame(-30000));
  m.write('b', frame(-30000));
  assert.equal(sample(m.mix()), -32768);
  m.destroy();
});

test('PcmMixer: re-frames unaligned chunks and drops old audio past the queue cap', () => {
  const m = new PcmMixer({ maxQueueFrames: 3, prebufferFrames: 1 });
  const one = frame(5);
  m.write('a', one.subarray(0, 1000)); // not a whole frame yet
  assert.equal(m.mix(), null);
  m.write('a', one.subarray(1000));
  assert.equal(sample(m.mix()), 5);

  for (let i = 1; i <= 6; i += 1) m.write('b', frame(i));
  assert.equal(m.sources.get('b').queue.length, 3);
  assert.equal(sample(m.mix()), 4); // the newest frames survived
  m.destroy();
});

test('PcmMixer: waits for a small head start, then plays a speaker out and forgets them', () => {
  const m = new PcmMixer({ prebufferFrames: 2 });
  m.write('a', frame(1));
  assert.equal(m.mix(), null); // one frame is not enough to start smoothly
  m.write('a', frame(2));
  assert.equal(sample(m.mix()), 1);
  assert.equal(sample(m.mix()), 2);
  assert.equal(m.mix(), null);

  m.write('b', frame(9)); // a short burst that ends before the head start fills
  m.finish('b');
  assert.equal(sample(m.mix()), 9);
  m.mix();
  assert.equal(m.sources.has('b'), false);
  m.destroy();
});

// ----------------------------------- the real player, across pauses in speech ----

const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('MixerPlayback keeps working across pauses that would kill a single long stream', async () => {
  const mixer = new PcmMixer({ prebufferFrames: 1 });
  const player = createAudioPlayer({ behaviors: { noSubscriber: 'play' } });
  player.on('error', () => {});
  const playback = new MixerPlayback({
    mixer,
    player,
    createResource: createAudioResource,
    rawType: StreamType.Raw,
    hangoverFrames: 6,
  });
  try {
    // Nobody has spoken yet: nothing may be created, and nothing may die.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(playback.opened, 0);
    assert.equal(player.state.status, AudioPlayerStatus.Idle);

    // First sentence.
    for (let i = 0; i < 10; i += 1) mixer.write('u', frame(2000));
    await waitFor(() => playback.opened === 1 && player.state.status === AudioPlayerStatus.Playing);

    // A pause far longer than the player's own 5-frame tolerance.
    await waitFor(() => playback.stream === null && player.state.status === AudioPlayerStatus.Idle);

    // The next sentence must still come through, on a fresh stream.
    for (let i = 0; i < 10; i += 1) mixer.write('u', frame(2000));
    await waitFor(() => playback.opened === 2 && player.state.status === AudioPlayerStatus.Playing);
  } finally {
    playback.destroy();
    player.stop(true);
  }
});

test('MixerPlayback bridges short gaps inside a sentence without opening a new stream', async () => {
  const mixer = new PcmMixer({ prebufferFrames: 1 });
  const opened = [];
  const playback = new MixerPlayback({
    mixer,
    player: { play: (r) => opened.push(r) },
    createResource: (stream) => ({ stream }),
    rawType: 'raw',
    hangoverFrames: 10,
    autostart: false,
  });
  mixer.write('u', frame(100));
  playback.tick();
  for (let i = 0; i < 5; i += 1) playback.tick(); // a 100 ms gap
  mixer.write('u', frame(100));
  playback.tick();
  assert.equal(opened.length, 1);
  for (let i = 0; i < 12; i += 1) playback.tick(); // longer than the hangover
  assert.equal(playback.stream, null);
  mixer.write('u', frame(100));
  playback.tick();
  assert.equal(opened.length, 2);
  playback.destroy();
});

// ------------------------------------------------- real Opus round trip ----

test('opus decode keeps the audio: encoded speech comes out as non-silent PCM', async () => {
  const enc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  const dec = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  enc.pipe(dec);
  const pcm = Buffer.alloc(FRAME_BYTES * 10);
  for (let i = 0; i < pcm.length / 4; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 12000);
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  const chunks = [];
  dec.on('data', (c) => chunks.push(c));
  enc.end(pcm);
  await new Promise((r) => dec.once('end', r));
  const out = Buffer.concat(chunks);
  assert.ok(out.length >= FRAME_BYTES * 8, `decoded ${out.length} bytes`);
  let peak = 0;
  for (let i = 0; i < out.length; i += 2) peak = Math.max(peak, Math.abs(out.readInt16LE(i)));
  assert.ok(peak > 3000, `peak ${peak}`);
});

// ------------------------------------------------- session with fake voice ----

function fakeVoice() {
  const connections = [];
  const voice = {
    VoiceConnectionStatus: {
      Ready: 'ready',
      Disconnected: 'disconnected',
      Destroyed: 'destroyed',
      Signalling: 'signalling',
      Connecting: 'connecting',
    },
    EndBehaviorType: { AfterSilence: 1 },
    NoSubscriberBehavior: { Play: 'play' },
    StreamType: { Raw: 'raw' },
    entersState: async () => {},
    createAudioResource: (stream) => ({ stream }),
    createAudioPlayer: () => Object.assign(new EventEmitter(), { play() {}, stop() {} }),
    joinVoiceChannel(opts) {
      const connection = new EventEmitter();
      connection.opts = opts;
      connection.state = { status: 'ready' };
      connection.subscribed = [];
      connection.subscribe = (p) => connection.subscribed.push(p);
      connection.streams = new Map();
      connection.receiver = {
        speaking: new EventEmitter(),
        subscribe: (userId) => {
          const s = new PassThrough();
          connection.streams.set(userId, s);
          return s;
        },
      };
      connection.destroy = () => {
        connection.state.status = 'destroyed';
        connection.emit('destroyed');
      };
      connections.push(connection);
      return connection;
    },
  };
  return { voice, connections, createDecoder: () => new PassThrough() };
}

function fakeGuild(channelIds, { canConnect = true } = {}) {
  const sent = [];
  const channels = new Map(
    channelIds.map((id) => [
      id,
      {
        id,
        name: `vc-${id.slice(-1)}`,
        type: ChannelType.GuildVoice,
        permissionsFor: () => ({ has: () => canConnect }),
        send: async (m) => void sent.push({ id, ...m }),
      },
    ])
  );
  return {
    id: G,
    sent,
    channels: { cache: channels },
    members: { me: { user: { username: 'bot' } }, cache: new Map([[BOT, { user: { bot: true } }]]) },
    voiceStates: { cache: new Map() },
    voiceAdapterCreator: () => ({}),
    client: { users: { cache: new Map() } },
  };
}

const CFG = { inputChannelId: IN, outputChannelId: OUT, twoWay: false, active: true, announce: true };

async function setup(cfg = CFG) {
  const deps = fakeVoice();
  const main = fakeGuild([IN, OUT]);
  const relay = fakeGuild([IN, OUT]);
  const session = await startRelay({ mainGuild: main, relayGuild: relay }, cfg, deps);
  return { deps, main, relay, session };
}

const speak = (conn, userId, bytes) => {
  conn.receiver.speaking.emit('start', userId);
  conn.streams.get(userId)?.write(bytes);
};

test('one-way relay: input speech reaches the output mixer, bots are ignored', async () => {
  const { deps, session } = await setup();
  const [inConn, outConn] = deps.connections;
  assert.equal(relayActive(G), true);
  assert.equal(inConn.opts.group, 'relay-in');
  assert.equal(outConn.opts.group, 'relay-out');
  assert.equal(inConn.opts.selfDeaf, false); // listens
  assert.equal(outConn.opts.selfDeaf, true); // output only speaks
  assert.equal(inConn.subscribed.length, 0);
  assert.equal(outConn.subscribed.length, 1);

  speak(inConn, HUMAN, Buffer.concat([frame(900), frame(900)]));
  await new Promise((r) => setImmediate(r));
  assert.equal(sample(session.output.mixer.mix()), 900);

  speak(inConn, BOT, frame(900)); // a bot in the channel is never relayed
  assert.equal(inConn.streams.has(BOT), false);
  speak(outConn, HUMAN2, frame(500)); // the output side is not listened to
  assert.equal(outConn.streams.has(HUMAN2), false);

  assert.deepEqual(
    { running: true, twoWay: false, inputChannelId: IN, outputChannelId: OUT },
    (({ running, twoWay, inputChannelId, outputChannelId }) => ({
      running,
      twoWay,
      inputChannelId,
      outputChannelId,
    }))(relayStatus(G))
  );
  session.stop();
});

test('two-way relay: both channels hear each other', async () => {
  const { deps, session } = await setup({ ...CFG, twoWay: true });
  const [inConn, outConn] = deps.connections;
  assert.equal(inConn.subscribed.length, 1); // main bot speaks into the input channel too
  assert.equal(outConn.opts.selfDeaf, false);

  speak(inConn, HUMAN, Buffer.concat([frame(100), frame(100)]));
  speak(outConn, HUMAN2, Buffer.concat([frame(250), frame(250)]));
  await new Promise((r) => setImmediate(r));
  assert.equal(sample(session.output.mixer.mix()), 100);
  assert.equal(sample(session.input.mixer.mix()), 250);
  session.stop();
});

test('stop leaves both channels, frees the guild and says so in chat', async () => {
  const { deps, main, relay, session } = await setup();
  assert.ok(relays.has(G));
  assert.equal(main.sent.length, 1); // start notice in the input channel's chat
  assert.equal(relay.sent.length, 1);
  session.stop('test');
  assert.deepEqual(
    deps.connections.map((c) => c.state.status),
    ['destroyed', 'destroyed']
  );
  assert.equal(relayActive(G), false);
  assert.equal(relays.has(G), false);
  assert.equal(relayStatus(G).running, false);
  session.stop(); // idempotent
});

test('the start notice can be turned off', async () => {
  const deps = fakeVoice();
  const main = fakeGuild([IN, OUT]);
  const relay = fakeGuild([IN, OUT]);
  const session = await startRelay({ mainGuild: main, relayGuild: relay }, { ...CFG, announce: false }, deps);
  assert.equal(main.sent.length + relay.sent.length, 0);
  session.stop();
});

test('startRelay refuses bad setups and cleans up after failures', async () => {
  const deps = fakeVoice();
  const main = fakeGuild([IN, OUT]);
  const relay = fakeGuild([IN, OUT]);
  const start = (cfg, guilds = { mainGuild: main, relayGuild: relay }, d = deps) =>
    startRelay(guilds, cfg, d);

  await assert.rejects(start({ ...CFG, outputChannelId: '' }), RelayError);
  await assert.rejects(start({ ...CFG, outputChannelId: IN }), /różne/);
  await assert.rejects(start(CFG, { mainGuild: main, relayGuild: undefined }), /Drugi bot/);
  await assert.rejects(
    start(CFG, { mainGuild: main, relayGuild: fakeGuild([IN, OUT], { canConnect: false }) }),
    /uprawnień/
  );
  assert.equal(relayActive(G), false, 'a failed start must not leave the guild marked busy');

  const broken = fakeVoice();
  broken.voice.entersState = async () => {
    throw new Error('timeout');
  };
  await assert.rejects(start(CFG, undefined, broken), /dołączyć/);
  assert.ok(broken.connections.every((c) => c.state.status === 'destroyed'));
  assert.equal(relayActive(G), false);

  const first = await start(CFG);
  await assert.rejects(start(CFG), /już działa/);
  first.stop();
});

test('losing a connection stops the whole relay', async () => {
  const { deps, session } = await setup();
  deps.connections[1].emit('destroyed');
  assert.equal(session.stopped, true);
  assert.equal(relayActive(G), false);
});

test('relayInviteUrl: derived from the token, with only the permissions the relay needs', () => {
  const id = '123456789012345678';
  const token = `${Buffer.from(id).toString('base64')}.AbCdEf.secretpart`;
  const url = new URL(relayInviteUrl(token));
  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), id);
  assert.equal(url.searchParams.get('scope'), 'bot');
  // View Channel + Connect + Speak, nothing more
  assert.equal(BigInt(url.searchParams.get('permissions')), 0x400n + 0x100000n + 0x200000n);
  assert.ok(!relayInviteUrl(token).includes('secretpart')); // never leaks the token
  assert.equal(relayInviteUrl(''), null);
  assert.equal(relayInviteUrl('not-a-token'), null);
});

test('a speaker who talks again after a pause is not dropped', () => {
  const m = new PcmMixer();
  m.write('a', frame(1));
  m.finish('a');
  m.write('a', frame(2)); // new burst arrives before the old queue is gone
  assert.equal(m.sources.get('a').finished, false);
  m.destroy();
});

test('status reports how much speech each side has heard', async () => {
  const { deps, session } = await setup({ ...CFG, twoWay: true });
  const [inConn] = deps.connections;
  assert.equal(relayStatus(G).heard.input, 0);
  speak(inConn, HUMAN, Buffer.alloc(192_000)); // one second of audio
  await new Promise((r) => setImmediate(r));
  const st = relayStatus(G);
  assert.equal(st.heard.input, 1);
  assert.equal(st.heard.output, 0);
  assert.ok(st.heard.inputLastAt > 0);
  assert.equal(st.players.output, null); // fake player has no state, the field is just present
  session.stop();
});
