# Tidegap browser extension

Your Tidegap queue and the next clean grid window in the browser toolbar. One extension for Chrome, Edge, Firefox and Safari. It talks only to `tidegap ui` on this computer (`http://127.0.0.1`), with a client token you paste once.

- **Badge:** `?` not paired, `off` tidegap ui is not running, the active task count, `now` during a clean window, or the time to the next one (`45m`, `5h`). When tasks will not run (no tick daemon, no runner), the text gets a `!` in front (`!3`) and turns amber.
- **Popup:** the active tasks and the clean window. When tasks will not run, one line says why and how to fix it. Each task has **Later** (one hour later, tonight, tomorrow morning, after limit reset, each with its time; a preset that does not apply is greyed out with the reason), **Cancel** and **Run now**. Cancel and Run now ask once before they act. The popup never creates tasks: your agent does.
- **Notifications:** a task finishes; a clean grid window starts. Both can be turned off in the options.

The API contract is `docs/spec/ui-client-api.md`.

## Build

```sh
pnpm install
pnpm --filter @tidegap/extension build    # dist/chrome, dist/firefox, dist/safari and a zip each
pnpm --filter @tidegap/extension test
pnpm --filter @tidegap/extension lint     # addons-linter on dist/firefox
```

The version follows `packages/core-ts/package.json`.

## Install

**Chrome or Edge.** Open `chrome://extensions` (`edge://extensions`), turn on Developer mode, click "Load unpacked" and pick `apps/extension/dist/chrome`. Pin the Tidegap icon.

**Firefox.** Open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on…" and pick `apps/extension/dist/firefox/manifest.json`. A temporary add-on is removed when Firefox quits.

**Safari.** The `safari` build ships inside Tidegap for Mac; see "Safari extension" in `apps/macos/README.md`. Safari has no extension notifications; the Mac app sends them.

## Pair

1. Run `tidegap ui` (0.19 or later). It listens on port 47821 unless that port is taken.
2. Get a client token: "Connect an app" in the tidegap ui page, or `tidegap clients add --name browser --kind extension`.
3. Open the extension options, paste the token, check the port, and click Save. Firefox and Safari ask for access to 127.0.0.1 here; allow it.
4. Click "Test connection". It says "Connected" and the active task count.

Revoke the token in the page's "Connected apps" panel or with `tidegap clients revoke <id>`. The badge then shows `?`.

## Smoke check

`node apps/extension/scripts/smoke-chrome.mjs --out <dir>` loads `dist/chrome` into the Playwright Chromium against a seeded, throwaway `tidegap ui` and prints `PASS` or the failed steps. Build the CLI (`pnpm build`) and the extension first, and install Chromium once: `node node_modules/playwright-core/cli.js install chromium`.
