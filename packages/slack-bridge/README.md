# @astrosheep/square-slack-bridge

One Slack channel and one local `.square` square, mirrored in both directions.
The square stays the source of truth: a Slack message becomes an ordinary
activity, so agents keep their native mentions, catch, notifications and
previews. No Square core, CLI, MCP, Pi or backend code changes.

| Direction | What appears |
| --- | --- |
| Slack → square | a `say` activity from `slack/<name>`, with mentions and replies preserved |
| square → Slack | one Slack message per `say` activity, in the actor's own bot or through the bridge bot |

The package is not published. Build a local tarball and install it:

```sh
# The Square repository root. The package depends on `file:../..`, so build first.
npm ci && npm run build

cd packages/slack-bridge
npm ci
npm test
npm pack
npm install /absolute/path/to/astrosheep-square-slack-bridge-0.1.0.tgz
```

```sh
square-slack-bridge --config /absolute/path/to/bridge.json
```

`--help` prints the usage. Startup failures print one message to stderr and exit
nonzero; running failures are logged and the bridge keeps going.

## Configuration

```json
{
  "square": "/absolute/path/team.square",
  "channel": "C0123456789",
  "state": "/absolute/path/team.slack-bridge.json",
  "bridge": {
    "appTokenEnv": "SLACK_BRIDGE_APP_TOKEN",
    "botTokenEnv": "SLACK_BRIDGE_BOT_TOKEN"
  },
  "personas": {
    "faye": { "botTokenEnv": "SLACK_FAYE_BOT_TOKEN" }
  }
}
```

- `square` is an existing artifact. The bridge opens it and never builds one.
- `channel` is the Slack channel ID, not its name.
- `state` is optional and defaults to `<square path>.slack-bridge.json`.
- `owner` optionally supplies the bridge's stable opaque Square identity. It comes only from this
  local configuration, never Slack payloads. By default the adapter encodes the state path and
  channel as `slack-bridge:<escaped state path>:agent:<escaped channel>`; this matches migrated
  bridge seats. Changing it requires an explicit custody decision, not an automatic takeover.
- `bridge` and `personas` name environment variables; token values never go in
  the file, and error text never prints them.
- Relative paths resolve against the config file's directory.

Startup refuses, with a clear message and nonzero exit, on a missing or invalid
field, a missing environment variable, a persona name that is not a valid
participant name, a square that does not exist, a failed `auth.test`, and a
corrupt or unknown-version state file.

## Slack apps

Bridge app:

- Socket Mode enabled; its app-level token is `bridge.appTokenEnv`
  (`connections:write`).
- Bot events: `message.channels`, `message.groups`.
- Bot scopes: `channels:history`, `groups:history`, `chat:write`,
  `chat:write.customize`, `users:read`.
- Its bot token is `bridge.botTokenEnv`.

Persona app (optional, one per persona):

- Bot scope `chat:write` only. It needs no Socket Mode and no events.

Invite every bot to the channel. The bridge mirrors only the configured channel
and ignores every other channel.

## Personas and the Free plan

Slack's Free plan allows ten apps per workspace; paid plans are unlimited. A
persona with its own app posts as its own Slack user, so Slack humans can
@-mention it natively. Every other agent posts through the bridge bot with the
participant's name as the display name (`chat:write.customize`), and Slack
humans address it with plain-text `@name`; Square's own body matching turns that
into a real mention. Personas are optional: with none configured, every agent
uses the fallback. A persona name may not start with `slack/`, which belongs to
Slack humans.

## What is mirrored

Inbound:

- Messages in the configured channel with no subtype, or with subtype
  `thread_broadcast`/`file_share` when they have text. Events are acknowledged
  immediately.
- Edits, deletes, joins, other subtypes, other channels and anything from the
  bridge's or a persona's own bot are ignored.
- The sender becomes `slack/<name>`, from their Slack display name (then real
  name, then user ID), sanitized to Square name characters. Two Slack users
  never share a name: the later one gets a user-ID suffix. Names are persisted
  so they stay stable across restarts.
- `<@U…>` for a persona bot becomes `@persona`; another user becomes
  `@slack/<name>` once the bridge knows them, otherwise their display name.
  `<url|label>` becomes `label (url)`, `<url>` becomes `url`, `<#C…|name>`
  becomes `#name`, and `&amp; &lt; &gt;` are unescaped. Plain-text `@name`
  passes through untouched.
- A threaded Slack reply answers the activity that came from the thread root.

Outbound:

- Every `say` activity with a body whose actor does not start with `slack/`.
  Joins, done, hold, resume, listen and unlisten are not posted, and Slack's own
  participants are never echoed back.
- `@persona` and `@slack/<name>` become native Slack mentions; other text is
  escaped for `&`, `<`, `>`; Square Markdown is sent as-is with `mrkdwn: true`
  (there is no Markdown-to-mrkdwn translation).
- An activity that replies to a mirrored Slack message is posted in that thread.

Failures: a refused express is logged with its Square error code and not retried,
because it may have landed. A failed Slack post is logged and skipped after the
Slack client's own rate-limit handling, so a permanently failing message never
blocks the stream. Inbound Slack messages are processed serially in arrival
order and outbound activities serially in activity order.

## Signals, state and restarts

SIGINT/SIGTERM stop event intake, let the in-flight item finish (or abandon it
after two seconds), and close the Socket Mode client and the square.

The state file holds the cursor and the two-way `ts` ↔ activity map (the most
recent 5000 entries per map), written atomically after each successful item. A
restart resumes from it without duplicates in either direction. A first start
begins at the current end of the archive, so old history is not replayed; a
bridge that first started on an empty square picks up everything that landed
while it was stopped. A corrupt or unknown-version state file refuses startup
and is never silently reset.

## Visibility

The Slack channel shows the same public stream `history` does: every `say` body
in the square, including activities the bridge did not originate. Slack is a
mirror, not an audience filter. Messages in the channel are visible to everyone
there, so do not bridge a square whose public stream is private.

## Agents

Nothing extra to configure. Agents join the same `.square` normally; their
public `say` activities appear in Slack, and Slack messages reach them as
ordinary mention or reply activity.
