import './helpers/tmpDb.js';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localizeCommandDefinition } from '../src/bot/lib/commandLocalization.js';
import { commandDefinitionForRegistration } from '../src/bot/lib/commandAccess.js';

test('every built-in command and option has a valid Polish description on registration', async () => {
  function check(node) {
    assert.ok(node.description_localizations?.pl, node.name);
    assert.ok(node.description_localizations.pl.length <= 100, node.name);
    for (const option of node.options || []) check(option);
  }
  const folder = new URL('../src/bot/commands/', import.meta.url);
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.js'))) {
    const command = await import(new URL(file, folder));
    if (command.data) check(commandDefinitionForRegistration(command));
  }
});

test('command localization preserves routing, values, permissions and other languages without mutating the input', () => {
  const definition = {
    name: 'birthday',
    description: 'Set your birthday.',
    description_localizations: { de: 'Geburtstag einstellen.' },
    default_member_permissions: '8',
    options: [
      {
        name: 'month',
        type: 4,
        description: 'Month',
        required: true,
        choices: [{ name: 'January', value: 1 }],
      },
    ],
  };
  const before = structuredClone(definition);
  const result = localizeCommandDefinition(definition);
  assert.deepEqual(definition, before);
  assert.equal(result.name, definition.name);
  assert.equal(result.description, definition.description);
  assert.equal(result.default_member_permissions, '8');
  assert.equal(result.description_localizations.de, definition.description_localizations.de);
  assert.equal(result.options[0].name, 'month');
  assert.equal(result.options[0].choices[0].value, 1);
  assert.equal(result.options[0].choices[0].name_localizations.pl, 'Styczeń');
  assert.equal(
    localizeCommandDefinition({ name: 'custom', description: 'My own wording' }).description_localizations,
    undefined
  );
});
