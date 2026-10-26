---
id: apps
label: UI & apps
---

<!-- source: packages/cli/src/index.ts (ui, clients), packages/cli/ui/region-card.js, docs/spec/ui-client-api.md, apps/extension/README.md, apps/macos/README.md -->
`tidegap ui` is a local page for your queue: timeline, inbox, task detail and actions. The browser extension and the Mac app are clients of the same local server.

### tidegap ui {#ui}

```bash
npx -y @tidegap/cli ui            # opens http://127.0.0.1:47821/
npx -y @tidegap/cli ui --no-open  # prints the link only
```

- It listens on 127.0.0.1 only, on port 47821 unless that port is taken. `--port <n>` sets the port.
- It never sends tasks to a provider. The tick does that.
- While it runs, `~/.tidegap/ui.json` holds its port and pid, and no token.

### Settings → Grid region {#region-card}

The **Grid region** card in Settings shows the zone in use, where it came from and its data source, for example "From time zone Europe/Kyiv."

- Type in **Search** to narrow the **Region** list by zone code, name, country, grid operator or data source ("pol" finds Poland, "pjm" finds `US-MIDA-PJM`). Press **Save**. The page and its timeline use the new zone at once; the tick, the queue and the MCP server use it on their next tick or call.
- **Auto (time zone)** in the list removes the stored zone, so the time-zone guess applies again.
- When `tidegap ui --region` or `TIDEGAP_DEFAULT_REGION` sets the region, the card names the override and **Save** is off. The stored zone applies again when the override is removed.
- When the guess is approximate (a Ukrainian time zone gives `PL`: "No Ukrainian grid data yet") or falls back to `GB`, the card shows a note and a **Request your region** link.

The card is in the page and in the Mac app's Settings. The browser extension cannot change the region. The same setting from the terminal: [tidegap region](#cli-region).

### Connect an app {#clients}

Apps use a client token. Mint one in the page ("Connect an app") or on the command line:

```bash
tidegap clients add --name browser --kind extension
```

The token is printed once. `tidegap clients revoke <id>` stops it at once.

### Jobs view {#apps-jobs}

The **Jobs** tab of `tidegap ui` lists recurring jobs with their guarantee, the next and the last run. Open a job for its history, or create one with **New job**. A preview shows the guarantee and the first planned hour before you save. Deep links: `#/jobs`, `#/jobs/new`, `#/jobs/<id>`. More: [Jobs](#jobs).

### Browser extension {#extension}

Preview. One extension for Chrome, Edge, Firefox and Safari: the queue and the next clean window in the toolbar. It never creates tasks. A Jobs section lists the jobs with **Pause**, **Resume** and **Run now**; **Manage jobs** opens the page. The extension cannot create or edit jobs. Build it from source and paste the client token in its options. Steps: [apps/extension/README.md](https://github.com/tidegap/tidegap/blob/main/apps/extension/README.md).

### Tidegap for Mac {#mac}

Preview. A menu bar app for macOS 14 or later, with the Safari extension inside. It runs the `tidegap` CLI, starts `tidegap ui` and pairs itself on first launch, so there is no token to copy. A Jobs submenu lists the jobs with Run now, Pause and Resume; **New job on page…** and **Edit on page…** open the Jobs page. Install the CLI globally first. Steps: [apps/macos/README.md](https://github.com/tidegap/tidegap/blob/main/apps/macos/README.md).

### Client API {#client-api}

Both apps use the API in [docs/spec/ui-client-api.md](https://github.com/tidegap/tidegap/blob/main/docs/spec/ui-client-api.md). Every `/api/*` request sends `Authorization: Bearer <token>`.
