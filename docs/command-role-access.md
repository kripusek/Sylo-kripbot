# Moderation command role access

Open the server dashboard Commands page (also available in Moderation). Choose roles separately for each command and save.

Supported commands: `/warn`, `/ban`, `/kick`, `/timeout`, `/untimeout`, `/unban`, `/case`, `/history`, `/purge`, `/lock`, `/unlock`, `/lockdown`, `/slowmode`.

- With no roles selected, the command requires its usual Discord permission.
- With roles selected, members must have at least one selected role. The bot grants command access without granting the role a native Discord permission.
- Administrators bypass role and channel restrictions. Disabled commands remain disabled for everyone.
- Existing target checks and the bot's permissions still apply. Role access does not change Discord role hierarchy.

Restart the bot after updating so it registers the revised slash command definitions. Role changes in the dashboard take effect immediately after saving.

Delegated commands may appear in the command picker for other members; the bot checks access before executing them. Explicit restrictions under Discord Server Settings > Integrations may still hide commands from a selected role.
