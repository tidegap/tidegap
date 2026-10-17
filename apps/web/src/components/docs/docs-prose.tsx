/**
 * Styles for the HTML that scripts/build-docs.mjs renders from the committed
 * docs markdown. The source is first-party, so it goes in as HTML; no script
 * runs from it, and the CSP is unaffected.
 *
 * Wide tables and code blocks scroll inside their own box (R41), and every
 * heading clears the sticky header (plus the mobile bar below `lg`).
 */
const PROSE = [
  "text-[15px] leading-relaxed text-fg-muted",
  "[&_:is(h3,h4)]:scroll-mt-[120px] lg:[&_:is(h3,h4)]:scroll-mt-24",
  "[&_h3]:mt-10 [&_h3]:mb-3 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3]:text-fg",
  "[&_h4]:mt-6 [&_h4]:mb-2 [&_h4]:font-semibold [&_h4]:text-fg",
  "[&_p]:my-3 [&_strong]:font-semibold [&_strong]:text-fg",
  "[&_a]:text-accent [&_a]:underline-offset-2 hover:[&_a]:underline",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5",
  "[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-rule-hi [&_blockquote]:pl-4",
  "[&_hr]:my-8 [&_hr]:border-rule",
  "[&_code]:rounded [&_code]:bg-bg-alt [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-fg",
  "[&_pre]:my-4 [&_pre]:block [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-rule [&_pre]:bg-bg-elev [&_pre]:p-4 [&_pre]:text-xs [&_pre]:leading-relaxed",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-fg",
  "[&_.docs-table]:my-4 [&_.docs-table]:block [&_.docs-table]:max-w-full [&_.docs-table]:overflow-x-auto [&_.docs-table]:rounded-md [&_.docs-table]:border [&_.docs-table]:border-rule [&_.docs-table]:bg-bg-elev",
  "[&_table]:min-w-full [&_table]:text-left [&_table]:text-sm",
  "[&_th]:bg-bg-alt [&_th]:px-3 [&_th]:py-2 [&_th]:font-mono [&_th]:text-[11px] [&_th]:font-normal [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-fg-dim",
  "[&_td]:border-t [&_td]:border-rule [&_td]:px-3 [&_td]:py-2 [&_td]:align-top",
  "[&_td_code]:whitespace-nowrap",
  "[&_:is(pre,.docs-table):focus-visible]:outline-2 [&_:is(pre,.docs-table):focus-visible]:outline-accent",
].join(" ");

export function DocsProse({ html }: { html: string }) {
  return <div className={PROSE} dangerouslySetInnerHTML={{ __html: html }} />;
}
