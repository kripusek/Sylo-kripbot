// Optional second Discord client for the voice relay. A bot can occupy only one
// voice channel per server, so the relay's "output" side is a separate bot
// account (RELAY_BOT_TOKEN) that must be invited to the same server. It needs
// no commands and no privileged intents — just guilds and voice states.
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { runtime } from './runtime.js';
import { log } from './lib/log.js';

/** Log the relay bot in. Never throws: the relay is optional. */
export async function startRelayClient() {
  if (!config.relayBotToken) return null;
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  client.on('error', (err) => log.error('relay-bot', 'client error', err));
  client.once(Events.ClientReady, () => log.info('relay-bot', `logged in as ${client.user.tag}`));
  try {
    await client.login(config.relayBotToken);
  } catch (err) {
    log.error('relay-bot', `login failed, voice relay disabled: ${err.message}`);
    return null;
  }
  runtime.relayClient = client;
  return client;
}
