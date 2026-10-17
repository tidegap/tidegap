#!/usr/bin/env node
// Capture the homepage "See it" product views from a real `tidegap ui`.
//
//   node scripts/capture-screens.mjs
//
// Seeds a throwaway ledger with example tasks and serves it through
// scripts/ui-seed.mjs --serve (HOME redirected, provider and grid secrets
// removed), then writes:
//
//   apps/web/public/screens/tidegap-ui.webp        1280x800 at 2x (desktop frame)
//   apps/web/public/screens/tidegap-ui-phone.webp   640x800 at 2x (queue-list crop)
//
// Optional: --popup <png> converts a browser-extension popup capture into
// apps/web/public/screens/extension-popup.webp, cropped to --popup-crop
// x,y,w,h (CSS px of the source image).
//
// Needs `pnpm build` first (ui-seed runs the built CLI). Renderer:
// playwright-core with the installed Google Chrome (`channel: "chrome"`), or
// the browser at TIDEGAP_CHROME_PATH, as in scripts/render-images.mjs. WebP is
// encoded by Chrome's canvas encoder at quality 0.8, so no image tool is
// needed. Captures run locally and are committed; CI does not capture.

import { spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps/web/public/screens");
const QUALITY = 0.8;

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

/** Start ui-seed --serve and resolve with the printed tokenised link. */
async function startUi() {
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "scripts/ui-seed.mjs"), "--serve", "--port", String(port)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = await new Promise((ok, fail) => {
    let buf = "";
    const timer = setTimeout(() => fail(new Error("capture-screens: no `tidegap ui` link within 20 s")), 20_000);
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const match = buf.match(/https?:\/\/127\.0\.0\.1:\d+\/#token=\S+/);
      if (match) {
        clearTimeout(timer);
        ok(match[0]);
      }
    });
    child.on("exit", (code) => fail(new Error(`capture-screens: ui-seed exited (${code}) before serving`)));
  });
  return { url, stop: () => child.kill("SIGINT") };
}

/** Encode a PNG buffer to WebP in the page's canvas, optionally cropped (source px). */
async function toWebp(page, png, crop) {
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const webp = await page.evaluate(
    async ({ dataUrl, crop, quality }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = crop ?? { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
      const canvas = document.createElement("canvas");
      canvas.width = c.w;
      canvas.height = c.h;
      canvas.getContext("2d").drawImage(img, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
      return canvas.toDataURL("image/webp", quality);
    },
    { dataUrl, crop, quality: QUALITY },
  );
  if (!webp.startsWith("data:image/webp")) throw new Error("capture-screens: this Chrome cannot encode WebP");
  return Buffer.from(webp.split(",")[1], "base64");
}

function write(name, bytes) {
  const path = join(OUT, name);
  writeFileSync(path, bytes);
  console.log(`${relative(ROOT, path)}  ${statSync(path).size} bytes`);
}

const browser = await chromium.launch(
  process.env.TIDEGAP_CHROME_PATH ? { executablePath: process.env.TIDEGAP_CHROME_PATH } : { channel: "chrome" },
);
const ui = await startUi();
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  // The page keeps a live connection open, so wait for load plus one refresh, not network idle.
  await page.goto(ui.url, { waitUntil: "load" });
  await page.waitForTimeout(2000);

  write("tidegap-ui.webp", await toWebp(page, await page.screenshot()));

  await page.setViewportSize({ width: 640, height: 800 });
  await page.waitForTimeout(500);
  write("tidegap-ui-phone.webp", await toWebp(page, await page.screenshot()));

  const popup = option("--popup");
  if (popup) {
    const [x, y, w, h] = (option("--popup-crop") ?? "").split(",").map(Number);
    const crop = Number.isFinite(h) ? { x, y, w, h } : undefined;
    write("extension-popup.webp", await toWebp(page, readFileSync(popup), crop));
  }
} finally {
  ui.stop();
  await browser.close();
}
