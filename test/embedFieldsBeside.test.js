import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEmbed, buildPayload, foldFieldsBeside } from '../src/modules/messageCreator.js';
import { normaliseEmbedSpec, resolveWelcomeSpec } from '../src/modules/welcomeChannel.js';

const rules = [
  { name: '1.', value: 'Nie znajomość Regulaminu nie zwalnia z odpowiedzialności.' },
  { name: '2.', value: 'Zakaz spamu (flood, nadmierny caps lock).' },
  { name: '3.', value: 'Zakaz treści NSFW/18+.' },
];

test('by default fields stay real Discord fields (name above value)', () => {
  const data = buildEmbed({ title: 'Regulamin', fields: rules }).data;
  assert.equal(data.fields.length, 3);
  assert.equal(data.fields[0].name, '1.');
  assert.equal(data.description, undefined);
});

test('fieldsBeside writes "**1.** text" lines into the description instead of fields', () => {
  const data = buildEmbed({ title: 'Regulamin', fieldsBeside: true, fields: rules }).data;
  assert.equal(data.fields, undefined);
  assert.equal(
    data.description,
    [
      '**1.** Nie znajomość Regulaminu nie zwalnia z odpowiedzialności.',
      '**2.** Zakaz spamu (flood, nadmierny caps lock).',
      '**3.** Zakaz treści NSFW/18+.',
    ].join('\n')
  );
});

test('fieldsBeside keeps the description text above the rules', () => {
  const data = buildEmbed({ description: 'Zasady:', fieldsBeside: true, fields: rules }).data;
  assert.ok(data.description.startsWith('Zasady:\n\n**1.** '));
});

test('fieldsBeside alone is enough content for an embed, and "false" strings do not enable it', () => {
  assert.ok(buildEmbed({ fieldsBeside: true, fields: [rules[0]] }));
  assert.equal(buildEmbed({ fieldsBeside: 'false', fields: rules }).data.fields.length, 3);
  assert.equal(buildEmbed({ fieldsBeside: true, fields: [] }), null);
});

test('foldFieldsBeside overflows long lists into blank-named fields of at most 1024 characters', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `${i + 1}.`, value: 'x'.repeat(300) }));
  const { text, rest } = foldFieldsBeside(many, 1000);
  assert.ok(text.length <= 1000);
  assert.ok(rest.length >= 1);
  for (const f of rest) {
    assert.equal(f.name, '​');
    assert.ok(f.value.length <= 1024, `value ${f.value.length}`);
  }
  const lines = text.split('\n').length + rest.reduce((n, f) => n + f.value.split('\n').length, 0);
  assert.equal(lines, 25, 'no rule is lost or duplicated');
});

test('the whole 25 rules fit into a payload Discord accepts (<= 4096 description, <= 25 fields)', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `${i + 1}.`, value: 'y'.repeat(400) }));
  const { payload } = buildPayload({ embeds: [{ fieldsBeside: true, fields: many }] });
  const e = payload.embeds[0].data;
  assert.ok(e.description.length <= 4096);
  assert.ok((e.fields ?? []).length <= 25);
});

test('the flag survives the welcome / sticky sanitiser and placeholder resolution', () => {
  assert.equal(normaliseEmbedSpec({ fieldsBeside: true, fields: rules }).fieldsBeside, true);
  assert.equal(normaliseEmbedSpec({ fields: rules }).fieldsBeside, false);
  const guild = { name: 'Kpina', id: '1', memberCount: 3 };
  const cfg = { spec: { content: '', embeds: [normaliseEmbedSpec({ fieldsBeside: true, fields: rules })] } };
  assert.equal(resolveWelcomeSpec(cfg, guild).embeds[0].fieldsBeside, true);
});
