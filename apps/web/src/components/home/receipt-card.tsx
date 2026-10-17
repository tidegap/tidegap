import { Card, Chip } from "@/components/ui/card";

// Every value below is copied from docs/examples/2026-09-30-GB-tick/receipt.json
// (docs/claims.md row 31). Change them only together with that file.
const EXAMPLE_URL = "https://github.com/tidegap/tidegap/tree/main/docs/examples/2026-09-30-GB-tick";
const RECEIPT = {
  // receipt.json "region"
  region: "GB",
  // receipt.json "ranAt": 2026-09-30T21:03:33.059Z
  ranAt: "2026-09-30 21:03 UTC",
  // receipt.json "provider" and "model"
  model: "llama3.2:1b via Ollama",
  // receipt.json "totalTokens"
  tokens: 81,
  // receipt.json "intensityGCo2PerKwh" (measured at dispatch, claims row 31)
  intensity: 158,
  // receipt.json "gridSource": ukCarbonIntensity
  gridSource: "National Grid ESO",
  // receipt.json "signature", first and last 8 characters
  signature: "fBI2Geqq…gQMVAQ==",
};

/** The real signed receipt from one GB run (R9), as a card. */
export function ReceiptCard() {
  const rows: Array<[string, string]> = [
    ["Region", RECEIPT.region],
    ["Ran at", RECEIPT.ranAt],
    ["Model", RECEIPT.model],
    ["Tokens", String(RECEIPT.tokens)],
    ["Grid source", RECEIPT.gridSource],
  ];
  return (
    <Card className="flex h-full flex-col font-mono text-xs">
      <div className="flex items-center justify-between gap-3">
        <p className="type-eyebrow">Receipt</p>
        <Chip variant="accent">Ed25519-signed</Chip>
      </div>
      <p className="mt-5 text-[11px] uppercase tracking-wider text-fg-dim">Intensity at dispatch</p>
      <p className="mt-1 font-sans text-3xl font-extrabold tracking-tight text-fg tabular-nums">
        {RECEIPT.intensity} <span className="text-base font-semibold text-fg-muted">gCO₂/kWh</span>
      </p>
      <p className="type-caption mt-1">measured</p>
      <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-rule pt-4">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-dim">{k}</dt>
            <dd className="text-right text-fg">{v}</dd>
          </div>
        ))}
        <dt className="text-fg-dim">Signature</dt>
        <dd className="truncate text-right text-fg-muted">{RECEIPT.signature}</dd>
      </dl>
      <a
        href={EXAMPLE_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-auto inline-flex min-h-10 items-center pt-5 font-sans text-sm text-accent hover:underline"
      >
        View the run on GitHub →
      </a>
    </Card>
  );
}
