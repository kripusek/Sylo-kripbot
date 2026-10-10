# Tickets

## Discord ticket panel

In the Tickets module, enable the module and configure:

- **Panel channel**: the text channel containing the Open ticket button.
- **Panel title / Panel message**: the public panel text.
- **Ticket topics**: add up to 25 names, descriptions and destination categories. Categories contain the newly created private text channels.
- **Staff roles**: roles allowed to read and reply in newly created tickets. Administrators can also access them. Category permissions are not inherited; explicit private permissions protect each ticket.
- **Ticket log channel**: records member, topic and channel on opening, and member, closing user and channel on closure.

Click **Save and publish panel** to create or update the public button message. Clicking it opens a topic dropdown visible only to that member; choosing a topic opens the ticket form. Ordinary Save stores settings. Use Add topic / Remove topic whenever you need to change the options. Existing tickets retain their current permissions and destination.

Under **New ticket form**, edit the modal title and add or remove 1–5 text fields. Each field has a label, optional placeholder, short/long text style and required/optional setting. The first answer becomes the ticket title; remaining answers form its description. Saving applies the form to new openings.

**Roles to ping when a ticket opens** also configures the **Przywołaj administratora** button in each new ticket. The owner or staff can use it to ping all configured roles; members cannot choose their own ping targets. Each ticket has a five-minute call cooldown. Role and channel pickers support search by name or ID and removable selections.

The bot needs View Channel, Send Messages and Embed Links in the panel and log channels, and Manage Channels / Manage Roles to create channels and manage permission overwrites. The bot must be allowed to grant the ticket permissions.

Members may have one open channel ticket per server. Duplicate clicks are guarded. The **Close ticket** button is available to the owner or staff. Closing locks member replies, fetches all available message history, sends a text transcript to the Ticket log channel, then deletes the channel. A separate Ticket log channel is required. If fetching or delivery fails, the channel is retained and closure can be retried, including tickets closed by older bot versions. The bot needs Read Message History in tickets and Attach Files in the log channel. Transcripts contain text, embeds and attachment URLs; attachments are not reuploaded and their links may stop working after the source channel is deleted. Staff must manage retention of Discord transcript messages themselves. Channel tickets are independent of the dashboard modmail queue and its transcript retention; their conversations stay in Discord and are not copied into the modmail database. Changing Staff roles applies to new channel tickets.

# DM tickets (modmail)

Members open a ticket by **DMing the bot**. Staff read the conversation and reply
from the dashboard — replies are delivered to the member as a DM from Sylo.

**Dashboard:** `/guilds/<id>/tickets` (list) and `/guilds/<id>/tickets/<n>`
(conversation).

## Needs

- No extra Discord permissions and no privileged intents — just leave the bot
  able to receive DMs (Discord *Settings → Privacy* on the shared server).

## Settings

- **Enabled** — the module toggle is the on/off switch.
- **Staff roles** — who may view and reply to tickets on the dashboard (in
  addition to Manage Server / bot-master).
- **Open / close messages** — the DM text sent when a ticket opens and closes.
- **Log channel** — optional transcript summary when a ticket closes.
- **Include the opening message in the staff notification** — off by default;
  when on, the "new ticket" ping in the notification channel also embeds the
  member's first message (truncated past 1000 characters), so staff can see
  what it's about before opening it.
- **Delete closed tickets after** — days. A daily job removes closed tickets and
  every message in them once they are older than this. `0` (the default) keeps
  them forever; open tickets are never affected.

## How it works

A member's DM to the bot opens (or appends to) their one open ticket for that
server. Staff reply as **Staff** from the ticket page; the member sees Sylo's DM.
**Close ticket** sends a final reply (or the default closing notice if the box is
empty) and closes it. The member can open a new one by DMing again.

`/forget` removes the member's ticket history and the messages they sent; staff
replies already delivered are not clawed back.
