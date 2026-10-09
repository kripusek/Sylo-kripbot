# Complaints & feedback

Enable this module to accept complaints, staff feedback and suggestions through a Discord button and modal form.

1. Choose **Panel channel**, where members will see the button.
2. Choose a separate **Staff review channel** and restrict its Discord permissions to the intended reviewers.
3. Set the panel title, message and button label.
4. Choose whether **Anonymous submissions** is enabled. It is off by default.
5. Click **Save and publish panel** to create or update the public message.

The bot needs View Channel, Send Messages and Embed Links in both channels. The form contains Subject and Your complaint or feedback. Successful submissions are sent as embeds to the review channel. Members receive a private confirmation. Failed delivery is reported without a success confirmation.

Identified mode includes the author's Discord username and user ID. Anonymous mode omits those fields; users can still identify themselves in the text they write. The panel and modal state the privacy mode. If the mode changes while someone fills in the form, submission is rejected and they must open the form again. Anonymity here means identity is omitted from the staff message; it is not a promise of anonymity from Discord or the bot's hosting infrastructure.

One successful submission per member per minute is allowed. Cooldown timestamps are kept in memory and reset on restart. Submission text is not stored in the bot database. Discord review messages remain until staff delete them. Configure access and retention in accordance with your server's moderation needs.

## Feedback about a person

Select **Roles shown in member picker** to show only non-bot members with at least one selected role. Leave it empty for general feedback. The person picker is private to the submitting member and paginates lists longer than 25 people. Choosing a person opens a modal with a required whole-number rating from 0 to 5 and an opinion/complaint field. The staff message includes the chosen person and rating, plus the author when identified mode is enabled. The bot rechecks eligibility before accepting the submission.

Enable Server Members Intent in the Discord Developer Portal and the bot configuration to list all eligible members, including offline users.
