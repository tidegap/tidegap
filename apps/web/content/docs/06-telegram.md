---
id: telegram
label: Telegram
---

<!-- source: README.md (Telegram), packages/cli/ui/integrations.js, packages/cli/src/channels/telegram-setup.ts, packages/cli/src/commands/channels.ts, packages/cli/src/commands/env-file.ts, packages/core-ts/src/channels/format.ts -->
Tidegap can send task events to a Telegram chat. You can also run commands from that chat. This is a channel. Set it up in Settings → Integrations, in the `tidegap ui` page or the Mac app. The CLI does the same from a terminal.

### What you get {#telegram-features}

The bot sends a message when a task finishes or fails. It also tells you when a clean window starts and when queued tasks cannot run. A done message has a Result button.

These commands work in the paired chat:

| Command | What it does |
| --- | --- |
| `/queue` | The next 10 tasks, numbered. |
| `/later <n\|id> <1h\|tonight\|tomorrow\|reset [HH:MM]\|HH:MM>` | Run a task later. `HH:MM` is your local time. |
| `/run <n\|id>` | Run a task at the next tick. |
| `/cancel <n\|id>` | Cancel a task. |
| `/result <n\|id>` | The result of a finished task. |
| `/help` | This list. |

Numbers come from the last `/queue` and stay valid for 10 minutes. Run `/queue` again to get new numbers.

### Set up {#telegram-setup}

In the page or the Mac app:

1. Open Settings. In the page that `tidegap ui` opens, it is the Settings button at the top right. In the Mac app, choose **Integrations…** in the menu.
2. Create a bot with [@BotFather](https://t.me/BotFather): send `/newbot` and pick a name. Use this bot only for Tidegap.
3. Paste the token that @BotFather sends into the **Bot token** field and press **Connect** (or Enter). One click does everything: Tidegap tests the token, saves it, sets the bot's description, short description and command menu, and shows the pairing code. If Telegram refuses the token, the card says so under the field. Tidegap saves the token in `~/.config/tidegap/env` and never shows it again. If setting the profile fails, the card says so; pairing still works.
4. The card shows a 6-digit code, the `/pair <code>` command, the link and a QR code. Click the bot name, the code, the command or the link to copy it; **Open in Telegram** opens the link. Scan the QR code with the phone, or open the link. Telegram opens the bot; press **Start**. The code is valid for 10 minutes.
5. The card shows "Paired with @you". Press **Send test message** to check it.
6. Optional: press **Download avatar** on the card, then send `/setuserpic` to @BotFather and choose the file. The Bot API cannot set a bot's picture.

Only the page and the Mac app can open these settings. The browser extensions cannot.

What the card can show, and what to do:

| The card says | Do this |
| --- | --- |
| Telegram refused this token | Copy the token again from @BotFather and save it. |
| Another program reads this bot's messages | Another program polls the same bot. Create a new bot for Tidegap. |
| Listener not running | Press **Start listener**. |
| The listener cannot reach Telegram | Check the internet connection. |
| Listener runs by hand on this computer | Windows has no listener service. Keep `tidegap channels serve` running in a terminal. |

**Disconnect** removes the paired chat and stops the listener. Tick **Also delete the token** to remove the token from the env file too. A token for a different bot removes the paired chat; connect again after you save it.

From the terminal:

1. Create a bot with [@BotFather](https://t.me/BotFather). Use this bot only for Tidegap. If another program polls the bot, Telegram gives it a `409` error. Pairing then stops.
2. Put the bot token in `~/.config/tidegap/env`. Keep the file at mode `0600`:

   ```
   TIDEGAP_TELEGRAM_BOT_TOKEN=<token>
   ```

   Tidegap ignores a token that you only export in the shell. The listener runs without your shell, so it reads this file only.
3. Run `tidegap channels add telegram`. It prints a 6-digit code. The code is valid for 10 minutes.
4. Send `/pair <code>` to the bot in a private chat. You can also open `https://t.me/<bot>?start=<code>`. Groups are ignored. Five wrong codes stop the pairing.

Pairing installs and starts the listener. On macOS it is the LaunchAgent `com.tidegap.channels`. On Linux it is the systemd user unit `tidegap-channels.service`. Both run `tidegap channels serve` and restart it if it stops. On Windows, keep `tidegap channels serve` running yourself.

### Manage {#telegram-manage}

```bash
tidegap channels list           # paired channels (--json for JSON)
tidegap channels remove <id>    # unpair; the last Telegram channel stops the listener
```

The bot answers only the paired chat. Everyone else gets no reply. If pairing or the listener reports `409`, another program uses the same bot. Create a new bot for Tidegap.

A done message shows the first 600 characters of the result. That text goes to Telegram. A task with `redact_in_receipt` gets no preview. The token never appears in logs or errors.
