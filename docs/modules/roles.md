# Reaction roles & autoroles

Two features in one module:

- **Autoroles** — roles assigned automatically when a member joins.
- **Reaction roles** — a posted message members use to self-assign roles, via
  buttons or a select menu (Sylo uses interactions, not raw reactions).

**Dashboard:** `/guilds/<id>/m/roles`.

## Needs

- **Manage Roles**, with Sylo's role above every role it hands out.
- **Server Members** intent (`INTENT_GUILD_MEMBERS`) for autoroles.

## Settings

- **Autoroles** — a role list; also editable from the [Welcome](welcome.md)
  page's "Give roles to new members".
- **Reaction-role messages** — each has a channel, an embed, a style
  (buttons or a select menu), whether it's exclusive (one role at a time), and a
  list of role + label (+ emoji) pairs.

## Notes

- Editing a reaction-role message re-posts or edits it in place.
- Managed roles (bot roles, Nitro booster, etc.) can't be assigned and are
  dropped from the picker.

## Custom Discord emojis

Use the server section of the emoji picker, paste a Discord emoji mention (`<:name:id>` or `<a:name:id>`), `:name:`, its name, its numeric ID, `name:id`, or its Discord CDN URL. Server emojis are refreshed when the picker first opens; new emoji events also update the bot cache. External emojis must be accessible to the bot and may require Use External Emojis in the target channel. A typed shortcode only resolves emojis from this server. Unicode emojis continue to work.
