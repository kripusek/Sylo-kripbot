import { readFileSync } from 'node:fs';

// Reuse the dashboard's vocabulary for built-in Discord command metadata.
// Localizations change displayed descriptions/choice labels, never names or values.
const polish = JSON.parse(readFileSync(new URL('../../web/locales/pl.json', import.meta.url), 'utf8'));
const text = (value) => polish[String(value).replace(/\s+/g, ' ').trim()];

export function localizeCommandDefinition(definition) {
  const result = structuredClone(definition);
  function visit(node) {
    const description = text(node.description);
    if (description && description !== node.description && description.length <= 100) {
      node.description_localizations = { ...node.description_localizations, pl: description };
    }
    for (const choice of node.choices || []) {
      const name = text(choice.name);
      if (name && name !== choice.name && name.length <= 100) {
        choice.name_localizations = { ...choice.name_localizations, pl: name };
      }
    }
    for (const option of node.options || []) visit(option);
  }
  visit(result);
  return result;
}
