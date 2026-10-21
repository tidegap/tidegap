---
id: notifications
label: Notifications
---

<!-- source: packages/core-ts/src/channels (KIND_DESCRIPTORS, plan.ts, digest.ts, payload.ts), packages/cli/ui/channel-card.js, packages/cli/src/channels (channel-setup.ts, emit.ts, http.ts, url-policy.ts, secrets.ts, drivers/), packages/cli/src/commands/channels.ts. The per-kind steps, fields, presets and error tables come from KIND_DESCRIPTORS through `pnpm gen:docs`. -->
Tidegap can tell you when a task finishes, when a task fails, when a clean window starts and when queued tasks cannot run. It can also send one daily summary. Each place it sends to is a **channel**: Telegram, email, Slack, Discord, ntfy, Pushover, a webhook, a macOS Shortcut or a program on your computer. Desktop notifications (`os`) are built in and need no setup.

Set up a channel in Settings → Integrations, in the page that `tidegap ui` opens or in the Mac app. Each kind has a card with "where to get this" steps, the fields it needs and one **Connect** button. Connect checks the fields, sends a test message, saves the settings and turns the channel on. The CLI does the same with `tidegap channels add <kind>` (see [CLI](#notify-cli)).

`tidegap tick` sends the messages. A channel works only while the tick runs (`tidegap install` sets it up; `tidegap status` tells you if it runs).

### Events and quiet hours {#notify-events}

A connected card shows the events as chips. Turn a chip off to stop that event for that channel.

| Chip | Event | When it is sent |
| --- | --- | --- |
| Task finished | `task_done` | A task completed at this tick. |
| Task failed | `task_failed` | A task failed at this tick. |
| Clean window starts | `clean_window` | A clean window started (live forecast only, once per window). |
| Tasks cannot run | `not_ready` | Queued tasks cannot run, for example no runner for a provider. Once per change. |
| Daily summary | `digest` | Once a day. See [Daily summary](#notify-digest). |

**Quiet at night (22:00–09:00)** holds every event but the daily summary during those local hours. A "tasks cannot run" alert that starts at night is sent after 09:00. A task finished at night is not sent on its own; turn on the daily summary to see it in the morning.

### Daily summary {#notify-digest}

The daily summary is one message a day. It goes to each channel with the **Daily summary** chip on. The default time is 09:00 local time, the end of the quiet hours. See or change it with `tidegap channels digest` and `tidegap channels digest --at 07:30`, or in Settings → Integrations: type the time in **Daily summary at** and press Save.

The summary lists:

- the tasks done, failed and postponed since the previous summary, at most 10 titles per group, then "and N more";
- the carbon of the done tasks;
- the problems that still stop queued tasks;
- the number of queued tasks and the next clean window.

A day with nothing to report sends nothing. If the computer sleeps through the send time, the summary goes out at the next tick. One summary covers at most 48 hours, so a long sleep gives one summary, not several. If every send fails, the channel waits, then tries again (see [Failed sends](#notify-backoff)). The `last` value in `GET /api/integrations` is the time a summary last reached a channel.

On a channel that gets the summary, an alert for something the summary lists is not sent again on its own. An alert held overnight arrives once, inside the summary. An alert for something the summary does not list still arrives after 09:00. If the summary fails on one channel and reaches another, the failed channel gets its alerts on their own.

### Failed sends {#notify-backoff}

A channel whose send fails waits before the next try: 1 minute, then 2, 4 and so on, at most 1 hour. While it waits, it gets no events. After the wait it gets the daily summary, a "tasks cannot run" alert that no other channel got, and a clean-window alert if the window is still open. A task finished during the wait gets no message of its own; the daily summary lists it. The card shows "Retrying in N min". A successful send, Connect or Send test ends the wait.

### Test message {#notify-test}

Connect and **Send test** send one test message: "Test message from Tidegap. Notifications work." In the Tidegap JSON format (webhook and command) it has `"event": "test"`. Ignore that event in your own code, or use it to check the path. The result is the channel's last delivery: the card and `tidegap channels list` show its time and, on failure, its code.

### Telegram {#notify-telegram}

Telegram has its own page: [Telegram](#telegram). It pairs a chat instead of taking a URL, and the chat also takes commands (`/queue`, `/later`, `/run`, `/cancel`, `/result`).

<!-- embed:channel-telegram -->

### Email {#notify-email}

<!-- embed:channel-email -->

Use an app password, not your normal password. Gmail and iCloud need 2-step sign-in before they give one.

The login is usually your email address. Some relays use a user name instead: SendGrid uses `apikey`, Amazon SES its SMTP user name, Postmark the server token. With such a login, type your address in **From** (under "Server and addresses").

Outlook.com and Hotmail personal accounts are not supported: Microsoft turned off password sign-in for SMTP on them. Microsoft 365 work accounts work only when the admin allows SMTP AUTH.

Tidegap always checks the server's certificate. It signs in only over TLS, or to a mail server on this computer (`127.0.0.1`, security `none`).

```bash
tidegap channels add email --preset gmail --user you@gmail.com --secrets-stdin <<< '{"password": "abcd efgh ijkl mnop"}'
```

### Slack {#notify-slack}

<!-- embed:channel-slack -->

The URL must be on `hooks.slack.com/services/`. Task titles cannot link or mention people in Slack.

### Discord {#notify-discord}

<!-- embed:channel-discord -->

The URL must be on `discord.com` (or `discordapp.com`, `canary.discord.com`, `ptb.discord.com`). Messages never mention people.

### ntfy {#notify-ntfy}

<!-- embed:channel-ntfy -->

On a public server such as ntfy.sh, anyone who knows the topic can read your messages. Keep the random topic that the card makes, and treat it like a password.

```bash
tidegap channels add ntfy --server https://ntfy.sh --secrets-stdin <<< '{"topic": "tidegap-<random>"}'
```

### Pushover {#notify-pushover}

<!-- embed:channel-pushover -->

### Webhook {#notify-webhook}

<!-- embed:channel-webhook -->

The Tidegap JSON body (`"version": 1`):

```json
{
  "version": 1,
  "event": "task_done",
  "level": "success",
  "title": "Done: Weekly report",
  "text": "Done: Weekly report …",
  "at": "2026-10-20T07:00:00.000Z",
  "task": { "id": "t_…", "title": "Weekly report", "status": "completed", "grams": 1.4 }
}
```

`event` is `task_done`, `task_failed`, `clean_window`, `not_ready`, `digest` or `test`. `level` is `success`, `error`, `info` or `warning`. `task` is present for task events only. `title` and `text` are plain text from the task; escape them before you show them as HTML.

Every attempt of one message has the same `X-Tidegap-Delivery: <uuid>` header, so your receiver can drop duplicates. Tidegap tries up to 3 times on a network error, a 5xx or a 429, inside 20 seconds. It does not follow redirects.

With a signing secret, each request also has `X-Tidegap-Timestamp: <unix seconds>` and `X-Tidegap-Signature: sha256=<hex>`, the HMAC-SHA256 of `"<timestamp>.<body>"`. Check the signature over the raw body, and refuse a timestamp older than 5 minutes.

```js
// Node
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, rawBody, headers) {
  const ts = headers["x-tidegap-timestamp"];
  const sig = headers["x-tidegap-signature"] ?? "";
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const want = "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(sig), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

```python
# Python
import hashlib, hmac, time

def verify(secret: bytes, raw_body: bytes, headers) -> bool:
    ts = headers.get("X-Tidegap-Timestamp", "")
    sig = headers.get("X-Tidegap-Signature", "")
    if not (ts.isascii() and ts.isdigit()) or abs(time.time() - int(ts)) > 300:
        return False
    want = "sha256=" + hmac.new(secret, ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, want)
```

```bash
tidegap channels add webhook --format tidegap --secrets-stdin <<< '{"url": "https://example.com/hooks/tidegap", "secret": "<random>"}'
```

### Shortcuts {#notify-shortcuts}

<!-- embed:channel-shortcuts -->

Tidegap runs `/usr/bin/shortcuts run <name>` with the message in a temporary file as the input, with no shell. The shortcut must finish in 20 seconds and must not wait for you (no Ask for Input).

### Command {#notify-command}

<!-- embed:channel-command -->

The program gets the Tidegap JSON body (the [webhook](#notify-webhook) format) on its standard input. Exit code 0 means delivered. See the rules in [Security](#notify-security).

```bash
#!/bin/sh
# ~/bin/tidegap-notify: one line per message to a log file
/usr/bin/tee -a "$HOME/tidegap-notify.log" > /dev/null
```

```bash
chmod 755 ~/bin/tidegap-notify
tidegap channels add command --path "$HOME/bin/tidegap-notify"
```

### CLI {#notify-cli}

Every card action has a command. Channel ids are the kind (`webhook`, `email`…) or `telegram-<chat id>`. Exit codes: 0 success, 1 a refused value or a failed test, 2 a usage error (for example an unknown kind, or an unknown flag on a kind other than Telegram).

```bash
tidegap channels kinds                       # each kind's flags, secrets and presets here
tidegap channels add slack                   # prompts for the webhook URL, hidden
tidegap channels list                        # ID, KIND, STATE, EVENTS, LAST, TARGET (--json for JSON)
tidegap channels test slack                  # send a test message
tidegap channels set slack --events task_failed,digest --quiet night
tidegap channels disconnect slack            # stop; settings and secrets stay
tidegap channels connect slack               # test message, then send again
tidegap channels digest --at 08:00           # the daily summary's send time
tidegap channels remove slack                # remove the channel and its secrets
```

Secrets never go in flags. On a terminal, `channels add` asks for each missing secret with hidden input. Else pass one JSON object with `--secrets-stdin`. An unknown flag such as `--url` stops with exit 2 and never prints its value. `channels add telegram` takes no kind fields and ignores other flags.

`tidegap channels --help`:

```
Usage: tidegap channels [options] [command]

Notification channels: add (Telegram, webhook, Slack, Discord, ntfy, Pushover,
email, Shortcuts, command), test, connect, disconnect, set, remove, list,
digest

Options:
  -h, --help                 display help for command

Commands:
  add [options] <kind>       Set up a channel in one step: validate, send a
                             test message, then save. Telegram prints a pairing
                             code instead. Secrets come from --secrets-stdin
                             (one JSON object) or a hidden prompt, never from
                             flags. `tidegap channels kinds` lists each kind's
                             flags
  kinds [options]            List the kinds `channels add` takes here, with
                             their flags, secrets and presets
  connect [options] <id>     Connect a disconnected channel with its stored
                             settings: one test message, then it sends again
  test [options] <id>        Send a test message to a connected channel; the
                             result is its last delivery
  disconnect [options] <id>  Stop sending; settings and secrets stay for
                             `channels connect`
  set [options] <id>         Change a channel's events and quiet hours (no test
                             message); Telegram chats too
  list [options]             List the channels with their state, events, last
                             delivery and target (secrets as hints only)
  remove [options] <id>      Remove a channel and its secrets; removing the
                             last telegram channel unloads the listener
  digest [options]           Show or set the daily summary's local send time
                             (default 09:00, the end of quiet hours); channels
                             get it with the digest event
  serve [options]            Run the Telegram listener (the listener unit runs
                             this); --once polls one cycle
  help [command]             display help for command
```

`tidegap channels add --help`:

```
Usage: tidegap channels add [options] <kind>

Set up a channel in one step: validate, send a test message, then save.
Telegram prints a pairing code instead. Secrets come from --secrets-stdin (one
JSON object) or a hidden prompt, never from flags. `tidegap channels kinds`
lists each kind's flags

Options:
  --db <path>         SQLite queue path
  --no-load           Telegram: pair only; do not install or load the listener
                      unit
  --secrets-stdin     Read the secret fields as one JSON object on stdin, e.g.
                      {"url": "https://…"}
  --events <list>     Comma-separated:
                      task_done,task_failed,clean_window,not_ready,digest
                      (default: the kind's)
  --quiet <mode>      night (no messages 22:00–09:00 but the daily summary) or
                      off
  --clear <fields>    Comma-separated optional secrets to remove (an empty
                      secret otherwise keeps the stored one)
  --preset <id>       Email: gmail, icloud, fastmail or m365 fills the server,
                      port and security
  --user <value>      Email address (email)
  --host <value>      SMTP server (email)
  --port <value>      Port (email)
  --security <value>  Security (email)
  --from <value>      From (email)
  --to <value>        Send to (email)
  --server <value>    Server (ntfy)
  --priority <value>  Priority (ntfy)
  --format <value>    Body format (webhook)
  --name <value>      Shortcut name (shortcuts)
  --path <value>      Program (command)
  --args <value>      Arguments (command); repeat for each line
  -h, --help          display help for command
```

`tidegap channels set --help`:

```
Usage: tidegap channels set [options] <id>

Change a channel's events and quiet hours (no test message); Telegram chats too

Options:
  --db <path>      SQLite queue path
  --events <list>  Comma-separated:
                   task_done,task_failed,clean_window,not_ready,digest; an
                   empty string sends nothing
  --quiet <mode>   night or off
  -h, --help       display help for command
```

`tidegap channels digest --help`:

```
Usage: tidegap channels digest [options]

Show or set the daily summary's local send time (default 09:00, the end of
quiet hours); channels get it with the digest event

Options:
  --db <path>   SQLite queue path
  --at <HH:MM>  Local send time, 00:00 to 23:59
  -h, --help    display help for command
```

### Security {#notify-security}

- **Where secrets live.** Secret fields (URLs with tokens, passwords, topics, keys) go to `~/.config/tidegap/channel-secrets.json`, mode `0600` in a `0700` folder. The ledger and every API answer hold only non-secret settings and hints such as `··abcd`. The Telegram bot token lives in `~/.config/tidegap/env`. `tidegap channels remove <id>` deletes the channel's secrets. There is no uninstall command: delete both files by hand to remove every secret.
- **URL policy.** Webhook, Slack, Discord, ntfy and Pushover send to `http` and `https` only. Your own network is allowed (Home Assistant, n8n, a self-hosted ntfy). Tidegap refuses a user name or password inside the URL, link-local and cloud metadata addresses (`169.254.0.0/16`, `fe80::/10`), the unspecified address and the port of the `tidegap ui` page itself. It checks the address again on every send, after the DNS lookup. Plain `http` to a public host works, but the card warns that the message travels unencrypted.
- **Public ntfy topics.** On ntfy.sh a topic is the only key. Keep it random and secret, or use your own server with an access token.
- **Shortcuts and Command run on this computer.** Tidegap runs the program directly, never through a shell, with only `PATH`, `HOME`, `LANG` and `TMPDIR` set, in your home folder, and stops it after 20 seconds. Shortcuts runs the system program `/usr/bin/shortcuts`. For Command, before every run Tidegap checks that the file (and the target of a symlink) is a regular executable file that you own, and that no other user can write to it or its folder. A program owned by `root`, such as `/usr/bin/say`, is refused (`unsafe_path`): write a small script that you own and call the program from it. Arguments are not secret; other programs on this computer can see them.
- **`PATH` under launchd.** The tick that the LaunchAgent starts has a short `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`). Use full paths inside your script, for example `/opt/homebrew/bin/jq`.
- **What leaves the computer.** A message has the task title, its status and, for a done task, a preview of the result. A task with `redact_in_receipt` gets no preview. Pick channels you trust with that text.
