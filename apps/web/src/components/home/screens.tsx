import type { ReactNode } from "react";
import Image from "next/image";
import { Section } from "@/components/ui/section";

// Captures from scripts/capture-screens.mjs (seeded example queue, no user
// data). Width and height are the CSS size; the files are 2x.
const UI_DESKTOP = { src: "/screens/tidegap-ui.webp", width: 1280, height: 800 };
const UI_PHONE = { src: "/screens/tidegap-ui-phone.webp", width: 640, height: 800 };
// The extension popup, captured from a repo build in Chrome (1x).
const POPUP = { src: "/screens/extension-popup.webp", width: 352, height: 494 };

const UI_ALT =
  "The tidegap ui page: an agenda of queued AI tasks grouped by day, each with its scheduled hour and a carbon band such as very clean";

/** Real product views (R13): the queue page, the Mac menu bar and the extension popup. */
export function Screens() {
  return (
    <Section
      id="see"
      eyebrow="See it"
      title="See what is waiting, and when it will run."
      lead="Every queued task, its deadline and its clean hour, on your own computer."
    >
      <div className="grid items-start gap-5 lg:grid-cols-[2fr_1fr]">
        <Frame caption={<>The queue in your browser (<code className="font-mono">tidegap ui</code>)</>}>
          <Image
            {...UI_DESKTOP}
            alt={UI_ALT}
            loading="lazy"
            sizes="(min-width: 1024px) 740px, 100vw"
            className="hidden aspect-[1280/800] h-auto w-full lg:block"
          />
          <Image
            {...UI_PHONE}
            alt={UI_ALT}
            loading="lazy"
            sizes="100vw"
            className="aspect-[640/800] h-auto w-full lg:hidden"
          />
        </Frame>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">
          <Frame caption="The Mac menu bar. Illustration of the real layout">
            <MenuBarIllustration />
          </Frame>
          <Frame caption="The extension popup">
            <Image
              {...POPUP}
              alt="The browser extension popup: the active tasks with their run times, the clean window, and a quick-add form"
              loading="lazy"
              sizes="(min-width: 1024px) 360px, (min-width: 640px) 50vw, 100vw"
              className="aspect-[16/10] h-auto w-full object-cover object-top"
            />
          </Frame>
        </div>
      </div>
    </Section>
  );
}

function Frame({ caption, children }: { caption: ReactNode; children: ReactNode }) {
  return (
    <figure className="reveal">
      <div className="lift overflow-hidden rounded-xl border border-rule bg-bg-elev">{children}</div>
      <figcaption className="type-caption mt-2">{caption}</figcaption>
    </figure>
  );
}

const MENU_TASKS: Array<[label: string, status: string, time: string]> = [
  ["Classify the 40 open issues by area and severity", "running", "now"],
  ["Translate README.md into Ukrainian", "pending", "14:46"],
  ["Check my weekly limit list", "pending", "17:46"],
  ["Refactor the helpers in packages/cli", "pending", "Sun 03:00"],
];

/**
 * HTML illustration of the Tidegap for Mac menu bar window, mirroring
 * apps/macos/Tidegap/MenuBarView.swift (header, task rows, commands). Shown
 * until a clean screenshot of the open menu exists (plan Q2).
 */
function MenuBarIllustration() {
  return (
    <div
      role="img"
      aria-label="Illustration: the Tidegap menu bar window with the next clean window, four active tasks and the app commands"
      className="flex aspect-[16/10] flex-col bg-gradient-to-b from-[#1b2a3a] to-[#0f1822] text-[11px] text-white/90"
    >
      <div className="flex h-6 shrink-0 items-center justify-end gap-3 bg-black/30 px-3 font-mono text-[11px]">
        <span className="rounded bg-white/20 px-1.5">∿ 2</span>
        <span className="text-white/50">Sat 17:05</span>
      </div>
      <div className="mx-auto mt-1.5 w-[88%] rounded-lg border border-white/10 bg-[#24272c]/95 p-2.5 shadow-xl">
        <p className="text-[12px] font-semibold">Clean 15:00-10:00 · FR</p>
        <p className="text-white/50">4 active · 1 running</p>
        <div className="my-1.5 h-px bg-white/10" />
        <ul className="space-y-0.5">
          {MENU_TASKS.map(([label, status, time]) => (
            <li key={label} className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="text-[10px] text-white/50">{status}</span>
              <span className="font-mono text-[10px] text-white/50">{time}</span>
            </li>
          ))}
        </ul>
        <div className="my-1.5 h-px bg-white/10" />
        <div className="flex gap-1.5 text-[10px]">
          <span className="rounded bg-white/10 px-1.5 py-0.5">Open Tidegap window</span>
          <span className="rounded bg-white/10 px-1.5 py-0.5">Settings…</span>
          <span className="ml-auto rounded bg-white/10 px-1.5 py-0.5">Quit Tidegap</span>
        </div>
      </div>
    </div>
  );
}
