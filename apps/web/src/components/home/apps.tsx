import Link from "next/link";
import { Card, Chip } from "@/components/ui/card";

const APPS = [
  {
    name: "Tidegap for Mac",
    line: "Your queue in the menu bar: the next clean window, active tasks and quick add.",
    install: "Build from source (macOS 14+). Not in the App Store yet.",
  },
  {
    name: "Browser extension",
    line: "Chrome, Edge, Firefox, and Safari through the Mac app. The queue and the clean window in your toolbar.",
    install: "Load unpacked from a repo build. Not in the browser stores yet.",
  },
];

/** The two preview apps (R12): honest status, no store badges. */
export function Apps() {
  return (
    <div className="mt-10 grid gap-5 sm:grid-cols-2">
      {APPS.map((app) => (
        // reveal sits on a wrapper so its transform never fights the hover lift.
        <div key={app.name} className="reveal">
          <Card lift className="flex h-full flex-col">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-fg">{app.name}</h3>
              <Chip variant="preview">Preview</Chip>
            </div>
            <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">{app.line}</p>
            <p className="type-caption mt-4">{app.install}</p>
            <Link href="/docs#apps" className="mt-auto inline-flex min-h-10 items-center pt-3 text-sm text-accent hover:underline">
              How to install →
            </Link>
          </Card>
        </div>
      ))}
    </div>
  );
}
