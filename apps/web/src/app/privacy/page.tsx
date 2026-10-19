import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What Tidegap stores and where: the CLI, the local UI, the Mac app, the browser extension, the Telegram channel and this website.",
  alternates: { canonical: "https://www.tidegap.com/privacy" },
};

const REPO = "https://github.com/tidegap/tidegap";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold text-fg">{title}</h2>
      <div className="mt-3 space-y-3 text-fg-muted">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-3xl">
      <p className="type-eyebrow">Privacy</p>
      <h1 className="mt-2 text-3xl font-semibold text-fg">Privacy policy</h1>
      <p className="mt-3 text-fg-muted">
        Last updated 2026-10-19. Tidegap runs on your computer. The Tidegap project has no
        server that receives your tasks, prompts, results or tokens, and it collects no
        analytics from the software.
      </p>

      <Block title="What Tidegap stores, and where">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Ledger.</strong> Your tasks, schedule, carbon receipts and audit log are in
            a local SQLite file, <code>~/.tidegap/queue.db</code>. The receipt signing key is in
            <code>~/.tidegap</code> too. Tidegap never uploads them.
          </li>
          <li>
            <strong>Receipts.</strong> A receipt records the task id, time, grid region and
            source, carbon estimate and actual, provider, model, duration, token count and the
            prompt. Tidegap removes known API-key patterns from the stored prompt. A receipt
            stays on your machine unless you share it.
          </li>
          <li>
            <strong>Settings and secrets.</strong> Provider API keys and other settings are in
            your environment or in <code>~/.config/tidegap/env</code> (mode 0600).
          </li>
          <li>
            <strong>Client tokens.</strong> A client token pairs an app with <code>tidegap ui</code>.
            The registry, <code>~/.tidegap/ui-clients.json</code> (mode 0600), keeps only the
            SHA-256 of each token. <code>~/.tidegap/ui.json</code> (mode 0600) holds the port and
            process id of the running UI. You can revoke a token at any time.
          </li>
        </ul>
      </Block>

      <Block title="What leaves your machine">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>The task&apos;s own provider call.</strong> When a task runs, Tidegap sends
            its prompt to the LLM provider you chose, with your key. For Claude Code, Tidegap runs
            your own <code>claude</code> CLI, which uses your Claude sign-in. The provider&apos;s
            privacy policy applies to that call.
          </li>
          <li>
            <strong>Grid data.</strong> To find a clean window, Tidegap fetches public grid
            carbon-intensity data directly from the public source (UK Carbon Intensity API,
            US EIA, ENTSO-E, WattTime or Electricity Maps), not through a Tidegap server. These requests carry a grid region and, for
            providers that need one, your own API key. They carry no task content.
          </li>
          <li>
            <strong>Telegram, only if you set it up.</strong> The Telegram channel talks to the
            Telegram Bot API with your bot token. It sends task notifications and replies
            to your chat. Telegram handles those messages under its own
            policy.
          </li>
        </ul>
        <p>Nothing else is sent. Tidegap contains no telemetry and no crash reporting.</p>
      </Block>

      <Block title="Local UI, Mac app and browser extension">
        <p>
          <code>tidegap ui</code> listens on <code>127.0.0.1</code> only. The Mac app and the
          browser extension talk to it with a client token.
        </p>
        <p>
          The Mac app creates its token with <code>tidegap clients add</code> and keeps it in
          <code>~/Library/Application Support/Tidegap/client-token</code> (mode 0600). It keeps
          its settings in macOS user defaults. It connects only to <code>127.0.0.1</code>.
        </p>
        <p>
          The extension takes a token that you paste once. It stores the token, the port and a few display settings in the browser&apos;s
          local extension storage (<code>storage.local</code>). It requests only
          <code> http://127.0.0.1/*</code>. It reads no web page, browsing history or tabs, and
          it sends nothing to the Tidegap project or to any third party. It has no remote code.
        </p>
      </Block>

      <Block title="This website">
        <p>
          www.tidegap.com is hosted on Vercel. Vercel keeps standard server logs (IP address,
          user agent, requested URL) to run the service. The site has no analytics, no
          advertising and no tracking cookies. The Google and Bing verification tags in the page
          head only prove site ownership; they do not track visitors.
        </p>
      </Block>

      <Block title="Your control">
        <p>
          Delete <code>~/.tidegap</code>, <code>~/.config/tidegap</code> and{" "}
          <code>~/Library/Application Support/Tidegap</code> to remove all stored data. Remove the extension to remove its storage. Revoke a client token with{" "}
          <code>tidegap clients revoke &lt;id&gt;</code>.
        </p>
      </Block>

      <Block title="Contact">
        <p>
          Questions or requests:{" "}
          <a className="text-accent hover:underline" href={`${REPO}/issues`} target="_blank" rel="noreferrer">
            {REPO}/issues
          </a>
          . Changes to this policy appear on this page with a new date.
        </p>
      </Block>
    </article>
  );
}
