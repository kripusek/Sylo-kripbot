# Dashboard language

The V1 dashboard has a **PL / EN** switch at the bottom of the sidebar. English
is the default. The selection is stored in a `sylo_language` cookie for one year
and applies to that browser, including full pages, HTMX fragments and toasts.
No translation service, API key or new dependency is needed.

Switching reloads the current page. If a form has unsaved edits, the dashboard
asks before discarding them. Save changes first to keep them.

This controls the dashboard interface only. Discord messages, configured
message bodies, channel names, role names, member names and other user-written
content keep their original text. V2 and the bot's Discord language are separate.

## Maintaining translations

English is the source language. Add an English-to-Polish entry to
`src/web/locales/pl.json` when adding UI copy. Keep template placeholders intact.
`src/web/lib/i18n.js` translates literal template text and UI attributes before
EJS renders them, including partials. Editable values, code and scripts are
excluded. Dynamic UI metadata can use `uiText(value)` explicitly; do not use it
for user-written text or values sent to Discord.

Browser-generated UI uses `window.syloT(text)`. Server and browser share the
same dictionary and dynamic-message rules. Unknown phrases fall back to their
original text. Add tests for new dynamic messages or template contexts.
