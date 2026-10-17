// Voice relay: carry the talk of one voice channel into another, live.
//
// A bot can sit in only one voice channel per server, so a relay inside one
// server needs two bot accounts: the main bot joins the INPUT channel and
// listens, the second ("relay") bot — RELAY_BOT_TOKEN — joins the OUTPUT
// channel and plays what was heard. With `twoWay` each bot also does the
// opposite job, so both channels hear each other.
//
// config shape:
//   { inputChannelId, outputChannelId, twoWay, active, announce }
// `active` is what the panel and /relay toggle; the relay itself runs only
// while it is true and the module is enabled.
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import prism from 'prism-media';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { runtime } from '../runtime.js';
import { config as appConfig } from '../config.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { log } from '../lib/log.js';
import { PcmMixer, MixerPlayback } from './lib/pcmMixer.js';
import { markRelay } from './lib/relayState.js';
import { getSession as getMusicSession } from './music.js';
import { soundboardStatus } from './soundboard.js';

const id = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');
const CONNECT_TIMEOUT_MS = 15_000;
const SILENCE_END_MS = 300;
const RECONCILE_MS = 30_000;

export function normaliseVoiceRelay(raw = {}) {
  return {
    inputChannelId: id(raw.inputChannelId),
    outputChannelId: id(raw.outputChannelId),
    twoWay: raw.twoWay === true,
    active: raw.active === true,
    announce: raw.announce !== false,
  };
}

export class RelayError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
  }
}

const defaultDeps = {
  voice: {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    entersState,
    EndBehaviorType,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
  },
  createDecoder: () => new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 }),
};

/** Whether a second bot account is configured at all. */
export const relayBotConfigured = () => Boolean(appConfig.relayBotToken);

// View Channel + Connect + Speak: all the relay bot needs on its output channel.
const RELAY_INVITE_PERMISSIONS = '3146752';

/**
 * Invite link for the relay bot. A bot token starts with the base64 of the bot's
 * user id, which equals its application id, so the link works even when the
 * bot could not log in (wrong token, offline) — exactly when you need it.
 * @returns {string|null}
 */
export function relayInviteUrl(token = appConfig.relayBotToken) {
  const first = String(token ?? '').split('.')[0];
  const clientId = Buffer.from(first, 'base64').toString('utf8');
  if (!/^\d{17,20}$/.test(clientId)) return null;
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${RELAY_INVITE_PERMISSIONS}`;
}

const P = PermissionFlagsBits;

function checkChannel(guild, channelId, { speak }) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice)
    throw new RelayError('Wybierz zwykły kanał głosowy (nie scenę).');
  const needed = [P.ViewChannel, P.Connect, ...(speak ? [P.Speak] : [])];
  if (!channel.permissionsFor(guild.members.me)?.has(needed))
    throw new RelayError(
      `Bot „${guild.members.me?.user.username ?? '?'}” nie ma uprawnień do kanału ${channel.name} (Wyświetlanie, Łączenie${speak ? ', Mówienie' : ''}).`
    );
  return channel;
}

const isBot = (guild, userId) =>
  guild.members.cache.get(userId)?.user.bot ??
  guild.voiceStates.cache.get(userId)?.member?.user.bot ??
  guild.client.users.cache.get(userId)?.bot ??
  false;

/** Join one channel; `listen` receives audio, `speak` gets a mixer + player. */
async function openLeg({ guild, channelId, group, listen, speak, deps }) {
  const v = deps.voice;
  const connection = v.joinVoiceChannel({
    channelId,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    group,
    selfDeaf: !listen,
    selfMute: !speak,
  });
  try {
    await v.entersState(connection, v.VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
  } catch {
    connection.destroy();
    throw new RelayError('Nie udało się dołączyć do kanału głosowego.', 503);
  }
  const leg = {
    guild,
    channelId,
    connection,
    listening: new Set(),
    detach: null,
    mixer: null,
    player: null,
    heard: { bytes: 0, lastAt: 0 }, // audio received from this channel's members
  };
  if (speak) {
    leg.mixer = new PcmMixer();
    leg.player = v.createAudioPlayer({ behaviors: { noSubscriber: v.NoSubscriberBehavior.Play } });
    leg.player.on('error', (err) => log.warn('module:voice-relay', 'player error:', err.message));
    leg.playback = new MixerPlayback({
      mixer: leg.mixer,
      player: leg.player,
      createResource: v.createAudioResource,
      rawType: v.StreamType.Raw,
    });
    connection.subscribe(leg.player);
  }
  return leg;
}

/** Feed everything the members of `leg`'s channel say into `target`. */
function pipeSpeech(leg, target, deps) {
  const { receiver } = leg.connection;
  const onStart = (userId) => {
    if (leg.listening.has(userId) || isBot(leg.guild, userId)) return;
    leg.listening.add(userId);
    const opus = receiver.subscribe(userId, {
      end: { behavior: deps.voice.EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
    });
    const decoder = deps.createDecoder();
    const done = () => {
      if (!leg.listening.delete(userId)) return;
      target.finish(userId);
      decoder.destroy();
      opus.destroy();
    };
    decoder.on('data', (pcm) => {
      leg.heard.bytes += pcm.length;
      leg.heard.lastAt = Date.now();
      target.write(userId, pcm);
    });
    decoder.on('error', done); // a corrupt packet only ends that burst of speech
    opus.on('error', done);
    opus.once('end', done);
    opus.pipe(decoder);
  };
  receiver.speaking.on('start', onStart);
  leg.detach = () => receiver.speaking.off('start', onStart);
}

export class RelaySession {
  constructor({ guildId, input, output, twoWay, announce, deps }) {
    this.guildId = guildId;
    this.input = input;
    this.output = output;
    this.twoWay = twoWay;
    this.announce = announce;
    this.deps = deps;
    this.startedAt = Date.now();
    this.stopped = false;
    this.onStop = null;
  }

  get legs() {
    return [this.input, this.output];
  }

  wire() {
    pipeSpeech(this.input, this.output.mixer, this.deps);
    if (this.twoWay) pipeSpeech(this.output, this.input.mixer, this.deps);
    for (const leg of this.legs) {
      const { connection } = leg;
      connection.on(this.deps.voice.VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            this.deps.voice.entersState(connection, this.deps.voice.VoiceConnectionStatus.Signalling, 5000),
            this.deps.voice.entersState(connection, this.deps.voice.VoiceConnectionStatus.Connecting, 5000),
          ]);
        } catch {
          this.stop('Połączenie z kanałem zostało przerwane.');
        }
      });
      connection.on(this.deps.voice.VoiceConnectionStatus.Destroyed, () => this.stop());
      connection.on('error', (err) => log.warn('module:voice-relay', 'connection error:', err?.message));
    }
  }

  async say(text) {
    if (!this.announce) return;
    for (const leg of this.legs) {
      await leg.guild.channels.cache
        .get(leg.channelId)
        ?.send({ content: text, allowedMentions: { parse: [] } })
        .catch(() => {});
    }
  }

  async announceStart() {
    const inCh = this.input.channelId;
    const outCh = this.output.channelId;
    const notes = [
      [
        this.input,
        this.twoWay
          ? `🔁 Relay głosowy: ten kanał jest połączony z <#${outCh}> — rozmowy są przekazywane w obie strony.`
          : `🔁 Relay głosowy: to, co mówisz tutaj, słychać na <#${outCh}>.`,
      ],
      [
        this.output,
        this.twoWay
          ? `🔁 Relay głosowy: ten kanał jest połączony z <#${inCh}> — rozmowy są przekazywane w obie strony.`
          : `🔁 Relay głosowy: na tym kanale słychać rozmowę z <#${inCh}>.`,
      ],
    ];
    if (!this.announce) return;
    for (const [leg, text] of notes) {
      await leg.guild.channels.cache
        .get(leg.channelId)
        ?.send({ content: text, allowedMentions: { parse: [] } })
        .catch(() => {});
    }
  }

  status() {
    return {
      running: !this.stopped,
      inputChannelId: this.input.channelId,
      outputChannelId: this.output.channelId,
      twoWay: this.twoWay,
      since: this.startedAt,
      speakers: this.input.listening.size + (this.twoWay ? this.output.listening.size : 0),
      // Seconds of speech actually received per channel — tells "the bot hears
      // nobody" (stays 0) apart from "it hears but playback is silent".
      heard: {
        input: Math.round(this.input.heard.bytes / 192_000),
        output: Math.round(this.output.heard.bytes / 192_000),
        inputLastAt: this.input.heard.lastAt,
        outputLastAt: this.output.heard.lastAt,
      },
      players: {
        input: this.input.player?.state?.status ?? null,
        output: this.output.player?.state?.status ?? null,
      },
    };
  }

  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    for (const leg of this.legs) {
      leg.detach?.();
      leg.player?.stop(true);
      leg.playback?.destroy();
      if (leg.connection.state.status !== this.deps.voice.VoiceConnectionStatus.Destroyed)
        leg.connection.destroy();
    }
    markRelay(this.guildId, false);
    this.onStop?.(this);
    if (reason) log.info('module:voice-relay', `${this.guildId} stopped: ${reason}`);
  }
}

/** Running relays by guild id. */
export const relays = new Map();
const starting = new Set();

export function relayStatus(guildId) {
  return relays.get(guildId)?.status() ?? { running: false };
}

export function stopRelay(guildId, reason) {
  const session = relays.get(guildId);
  if (!session) return false;
  session.say('🔇 Relay głosowy został zatrzymany.').catch(() => {});
  session.stop(reason);
  return true;
}

/**
 * Start a relay from a normalised config.
 * @param {{ mainGuild: import('discord.js').Guild, relayGuild: import('discord.js').Guild }} guilds
 */
export async function startRelay({ mainGuild, relayGuild }, cfg, deps = defaultDeps) {
  const guildId = mainGuild.id;
  if (!cfg.inputChannelId || !cfg.outputChannelId)
    throw new RelayError('Wybierz kanał wejściowy i wyjściowy.');
  if (cfg.inputChannelId === cfg.outputChannelId) throw new RelayError('Kanały muszą być różne.');
  if (relays.has(guildId) || starting.has(guildId))
    throw new RelayError('Relay już działa na tym serwerze.', 409);
  if (!relayGuild)
    throw new RelayError('Drugi bot (relay) nie jest na tym serwerze albo nie jest połączony.', 409);
  if (getMusicSession(guildId) || soundboardStatus(guildId).connected || soundboardStatus(guildId).playing)
    throw new RelayError('Muzyka lub soundboard używają teraz kanału głosowego. Zatrzymaj je najpierw.', 409);

  starting.add(guildId);
  markRelay(guildId, true);
  let input;
  let output;
  try {
    // Main bot listens to the input channel; the relay bot speaks in the output.
    checkChannel(mainGuild, cfg.inputChannelId, { speak: cfg.twoWay });
    checkChannel(relayGuild, cfg.outputChannelId, { speak: true });
    input = await openLeg({
      guild: mainGuild,
      channelId: cfg.inputChannelId,
      group: 'relay-in',
      listen: true,
      speak: cfg.twoWay,
      deps,
    });
    output = await openLeg({
      guild: relayGuild,
      channelId: cfg.outputChannelId,
      group: 'relay-out',
      listen: cfg.twoWay,
      speak: true,
      deps,
    });
  } catch (err) {
    input?.connection.destroy();
    output?.connection.destroy();
    markRelay(guildId, false);
    starting.delete(guildId);
    throw err;
  }
  const session = new RelaySession({
    guildId,
    input,
    output,
    twoWay: cfg.twoWay,
    announce: cfg.announce,
    deps,
  });
  session.onStop = () => relays.delete(guildId);
  relays.set(guildId, session);
  starting.delete(guildId);
  session.wire();
  await session.announceStart();
  return session;
}

/** Look both bots' guild objects up and start the relay from a saved config. */
export async function startConfigured(guildId, cfg, deps) {
  if (!relayBotConfigured()) throw new RelayError('Relay wymaga drugiego bota: ustaw RELAY_BOT_TOKEN.', 409);
  const mainGuild = runtime.client?.guilds.cache.get(guildId);
  if (!mainGuild) throw new RelayError('Bot nie jest na tym serwerze.', 404);
  return startRelay({ mainGuild, relayGuild: runtime.relayClient?.guilds.cache.get(guildId) }, cfg, deps);
}

/**
 * Bring one guild's relay in line with its saved config: stop it when the
 * module is off, `active` is off or the channels changed; start it when
 * `startIfNeeded` and the config asks for it. Returns an error text or null.
 */
export async function reconcileGuild(guildId, { startIfNeeded = false } = {}) {
  const row = await getGuildModule(guildId, 'voice-relay');
  const cfg = normaliseVoiceRelay(row.config);
  const wanted = (await isModuleEnabled(guildId, 'voice-relay')) && cfg.active;
  const running = relays.get(guildId);
  if (running) {
    const same =
      running.input.channelId === cfg.inputChannelId &&
      running.output.channelId === cfg.outputChannelId &&
      running.twoWay === cfg.twoWay;
    if (wanted && same) return null;
    stopRelay(guildId, wanted ? 'config changed' : 'turned off');
    if (!wanted) return null;
    await new Promise((r) => setTimeout(r, 500)); // let Discord register the leave
  }
  if (!wanted || !startIfNeeded) return null;
  try {
    await startConfigured(guildId, cfg);
    return null;
  } catch (err) {
    if (!(err instanceof RelayError)) log.error('module:voice-relay', 'start failed:', err.message);
    return err.message;
  }
}

/** Resume relays that were active before a restart. */
export async function resumeRelays() {
  if (!relayBotConfigured() || !runtime.client?.isReady()) return;
  for (const guild of runtime.client.guilds.cache.values()) {
    try {
      if (!(await isModuleEnabled(guild.id, 'voice-relay'))) continue;
      if (!normaliseVoiceRelay((await getGuildModule(guild.id, 'voice-relay')).config).active) continue;
      const error = await reconcileGuild(guild.id, { startIfNeeded: true });
      if (error) log.warn('module:voice-relay', `${guild.id}: could not resume: ${error}`);
    } catch (err) {
      log.error('module:voice-relay', 'resume failed:', err.message);
    }
  }
}

// Stop relays whose module was switched off or whose config was edited elsewhere.
const reconcileTimer = setInterval(() => {
  for (const guildId of [...relays.keys()])
    reconcileGuild(guildId).catch((err) => log.error('module:voice-relay', 'reconcile failed:', err.message));
}, RECONCILE_MS);
reconcileTimer.unref();
