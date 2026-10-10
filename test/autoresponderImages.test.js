import { startWebApp, post } from './helpers/webApp.js';
import { GID, CH } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseAutoresponder,
  buildAutoresponderReply,
  autoresponderValidationError,
} from '../src/modules/autoresponder.js';
import { dispatch } from '../src/modules/dispatch.js';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';

const urls = [1, 2, 3].map((n) => `https://example.com/${n}.png`);
const rules = [
  { trigger: 'cp', match: 'exact', response: 'serowa pizza' },
  { trigger: 'f', match: 'exact', responseType: 'random-image', response: '', imageUrls: urls },
];
const context = {
  userId: '123456789012345678',
  username: 'tester',
  guildName: 'Test',
  channelId: CH.general,
};

test('image-only rules survive normalisation, deduplicate URLs and reject invalid image input', () => {
  const cfg = normaliseAutoresponder({
    responders: [
      rules[0],
      { ...rules[1], imageUrls: ` ${urls.join('\r\n')}\n${urls[0]}\n javascript:alert(1)` },
      null,
    ],
  });
  assert.equal(cfg.responders.length, 2);
  assert.deepEqual(cfg.responders[1].imageUrls, urls);
  assert.equal(autoresponderValidationError(rules), null);
  assert.match(autoresponderValidationError([{ ...rules[1], imageUrls: [] }]), /co najmniej jeden/);
  assert.match(autoresponderValidationError([{ ...rules[1], imageUrls: ['javascript:alert(1)'] }]), /HTTP/);
});

test('random reply selects exactly one of all three images and preserves optional caption/placeholders', () => {
  const [text, image] = normaliseAutoresponder({ responders: rules }).responders;
  assert.equal(buildAutoresponderReply(text, context).content, 'serowa pizza');
  for (const [index, random] of [0, 0.4, 0.99].entries()) {
    const payload = buildAutoresponderReply(image, context, () => random);
    assert.equal(payload.embeds.length, 1);
    assert.equal(payload.embeds[0].toJSON().image.url, urls[index]);
    assert.equal(payload.content, undefined);
    assert.deepEqual(payload.allowedMentions.roles, []);
  }
  const caption = buildAutoresponderReply({ ...image, response: 'Hej {username}' }, context, () => 0);
  assert.equal(caption.content, 'Hej tester');
});

test('message dispatch responds to cp and f, ignores longer words, bots and ignored channels', async () => {
  const app = await startWebApp();
  try {
    await setGuildModule(GID, 'autoresponder', {
      enabled: true,
      config: { responders: rules, cooldownSeconds: 0, ignoreChannels: [CH.bots] },
    });
    const message = {
      guild: app.guild,
      channel: app.guild.channels.cache.get(CH.general),
      channelId: CH.general,
      member: { roles: { cache: new Map() } },
      author: { id: context.userId, username: 'tester', bot: false },
      content: 'cp',
    };
    await dispatch('messageCreate', GID, message);
    assert.equal(app.sink.messages[0].payload.content, 'serowa pizza');
    await dispatch('messageCreate', GID, { ...message, content: ' F ' });
    assert.ok(urls.includes(app.sink.messages[1].payload.embeds[0].toJSON().image.url));
    await dispatch('messageCreate', GID, { ...message, content: 'foo' });
    await dispatch('messageCreate', GID, { ...message, author: { ...message.author, bot: true } });
    await dispatch('messageCreate', GID, { ...message, channelId: CH.bots });
    assert.equal(app.sink.messages.length, 2);
  } finally {
    app.close();
  }
});

function v1Body(imageUrls = urls.join('\n')) {
  const body = new URLSearchParams({ cooldownSeconds: '0' });
  for (const rule of rules) {
    for (const [name, value] of Object.entries({
      ar_trigger: rule.trigger,
      ar_match: rule.match,
      ar_response: rule.response,
      ar_response_type: rule.responseType || 'text',
      ar_images: rule.imageUrls ? imageUrls : '',
      ar_embed: 'text',
      ar_delete: 'keep',
    }))
      body.append(name, value);
  }
  return body.toString();
}

test('V1 saves and renders text plus three image URLs; invalid image save leaves config intact', async () => {
  const app = await startWebApp();
  try {
    const path = `/guilds/${GID}/m/autoresponder/config`;
    assert.equal((await post(app.base, path, v1Body())).status, 302);
    const saved = (await getGuildModule(GID, 'autoresponder')).config;
    assert.equal(saved.responders[0].response, 'serowa pizza');
    assert.deepEqual(saved.responders[1].imageUrls, urls);
    const page = await (await fetch(`${app.base}/guilds/${GID}/m/autoresponder`)).text();
    assert.match(page, /Losowy obrazek/);
    for (const url of urls) assert.ok(page.includes(url));
    const invalid = await post(app.base, path, v1Body(''));
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /Odpowiedź 2/);
    assert.deepEqual((await getGuildModule(GID, 'autoresponder')).config, saved);
  } finally {
    app.close();
  }
});

test('V2 saves image-only responders and returns explicit errors without overwriting settings', async () => {
  const app = await startWebApp();
  try {
    const send = (responders) =>
      fetch(`${app.base}/api/v2/guilds/${GID}/modules/autoresponder/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ responders, cooldownSeconds: 0 }),
      });
    const response = await send(rules);
    assert.equal(response.status, 200);
    const saved = (await response.json()).config;
    assert.deepEqual(saved.responders[1].imageUrls, urls);
    const invalid = await send([{ ...rules[1], imageUrls: ['not a URL'] }]);
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /HTTP/);
    assert.deepEqual((await getGuildModule(GID, 'autoresponder')).config, saved);
  } finally {
    app.close();
  }
});
