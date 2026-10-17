---
id: apps
label: UI & apps
---

<!-- source: packages/cli/src/index.ts (ui, clients), docs/spec/ui-client-api.md, apps/extension/README.md, apps/macos/README.md -->
`tidegap ui` is a local page for your queue: timeline, inbox, task detail and actions. The browser extension and the Mac app are clients of the same local server.

### tidegap ui {#ui}

```bash
npx -y @tidegap/cli ui            # opens http://127.0.0.1:47821/
npx -y @tidegap/cli ui --no-open  # prints the link only
```

- It listens on 127.0.0.1 only, on port 47821 unless that port is taken. `--port <n>` sets the port.
- It never sends tasks to a provider. The tick does that.
- While it runs, `~/.tidegap/ui.json` holds its port and pid, and no token.

### Connect an app {#clients}

Apps use a client token. Mint one in the page ("Connect an app") or on the command line:

```bash
tidegap clients add --name browser --kind extension
```

The token is printed once. `tidegap clients revoke <id>` stops it at once.

### Browser extension {#extension}

Preview. One extension for Chrome, Edge, Firefox and Safari: the queue, the next clean window and a quick-add form in the toolbar. Build it from source and paste the client token in its options. Steps: [apps/extension/README.md](https://github.com/tidegap/tidegap/blob/main/apps/extension/README.md).

### Tidegap for Mac {#mac}

Preview. A menu bar app for macOS 14 or later, with the Safari extension inside. It runs the `tidegap` CLI, starts `tidegap ui` and pairs itself on first launch, so there is no token to copy. Install the CLI globally first. Steps: [apps/macos/README.md](https://github.com/tidegap/tidegap/blob/main/apps/macos/README.md).

### Client API {#client-api}

Both apps use the API in [docs/spec/ui-client-api.md](https://github.com/tidegap/tidegap/blob/main/docs/spec/ui-client-api.md). Every `/api/*` request sends `Authorization: Bearer <token>`.
