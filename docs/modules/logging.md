# Server logging

Sends server events to a log channel as embeds. Each event type is toggled
individually.

**Dashboard:** `/guilds/<id>/m/logging` (also the **Audit logging** tab on the
Moderator page).

## Needs

- **View Audit Log** for accurate "who did it" attribution on bans, kicks and
  role changes.
- **Server Members** intent (`INTENT_GUILD_MEMBERS`) for join/leave/nick/role
  events; **Message Content** intent (`INTENT_MESSAGE_CONTENT`) for message
  delete/edit content.

## Settings

- **Log channel** — one channel for all enabled events.
- **Events** — member join, member leave, member ban, member unban, member
  timeout, nickname change, role change (per member), message delete, message
  edit, bulk message delete, role create/delete, channel create/delete.

## Notes

- Deleted-message logging can only show content Discord still had cached; very
  old messages log as "content unavailable".
- This is separate from the **mod-log** (moderation actions Sylo itself takes),
  which is set under *General*.


## Separate log channels

Choose a Default log channel, then choose a Channel for each event. Use default channel preserves the shared destination. An event with its own channel works even without a default. Enable each event separately. The bot needs View Channel, Send Messages and Embed Links in each destination.

## Message sent

Disabled by default. Copies new server messages from members into the selected channel, including author ID, message ID, a jump link and up to 1024 characters of text. Requires Message Content Intent for text. DMs, bot messages, webhooks, system messages and configured log channels are excluded. No history is imported and attachments are not downloaded or copied.

Use this for a disclosed moderation purpose, restrict access and define a retention period. Log copies remain on Discord after the source message is deleted; /forget does not remove these copies. Automatic retention is not provided for Discord log channels.
