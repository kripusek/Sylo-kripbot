import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import prism from 'prism-media';
import { ChannelType } from 'discord.js';
import { PcmMixer, FRAME_BYTES } from '../src/modules/lib/pcmMixer.js';
import { relayActive } from '../src/modules/lib/relayState.js';
import {
  normaliseVoiceRelay,
  startRelay,
  relays,
  relayStatus,
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
  const m = new PcmMixer({ autostart: false });
  assert.equal(m.tick(), false);
  m.write('a', frame(1000));
  m.write('b', frame(-300));
  assert.equal(m.tick(), true);
  assert.equal(sample(m.read()), 700);

  m.write('a', frame(30000));
  m.write('b', frame(30000));
  m.tick();
  assert.equal(sample(m.read()), 32767); // clipped, not wrapped
  m.write('a', frame(-30000));
  m.write('b', frame(-30000));
  m.tick();
  assert.equal(sample(m.read()), -32768);
  m.destroy();
});

test('PcmMixer: re-frames unaligned chunks and drops old audio past the queue cap', () => {
  const m = new PcmMixer({ autostart: false, maxQueueFrames: 3 });
  const one = frame(5);
  m.write('a', one.subarray(0, 1000)); // not a whole frame yet
  assert.equal(m.tick(), false);
  m.write('a', one.subarray(1000));
  assert.equal(m.tick(), true);

  for (let i = 1; i <= 6; i += 1) m.write('b', frame(i));
  assert.equal(m.sources.get('b').queue.length, 3);
  m.tick();
  assert.equal(sample(m.read(), 0) >= 4, true); // the newest frames survived
  m.destroy();
});

test('PcmMixer: a finished speaker plays out its queue, then disappears', () => {
  const m = new PcmMixer({ autostart: false });
  m.write('a', frame(1));
  m.finish('a');
  assert.equal(m.tick(), true);
  assert.equal(m.tick(), false);
  assert.equal(m.sources.has('a'), false);
  m.destroy();
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

  speak(inConn, HUMAN, frame(900));
  await new Promise((r) => setImmediate(r));
  assert.equal(session.output.mixer.tick(), true);
  assert.equal(sample(session.output.mixer.read()), 900);

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

  speak(inConn, HUMAN, frame(100));
  speak(outConn, HUMAN2, frame(250));
  await new Promise((r) => setImmediate(r));
  session.output.mixer.tick();
  session.input.mixer.tick();
  assert.equal(sample(session.output.mixer.read()), 100);
  assert.equal(sample(session.input.mixer.read()), 250);
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
