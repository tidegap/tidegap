import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocsProse } from "@/components/docs/docs-prose";
import { DOCS_SECTIONS } from "@/lib/docs.generated";

const PRE = '<pre tabindex="0"><code>npm i -g @tidegap/cli</code></pre>';

describe("DocsProse", () => {
  it("renders one Copy code button per code block and keeps the code in the markup", () => {
    const html = renderToStaticMarkup(<DocsProse html={`<p>a</p>${PRE}<p>b</p>${PRE}`} />);
    expect(html.match(/aria-label="Copy code"/g)).toHaveLength(2);
    expect(html.match(/<pre /g)).toHaveLength(2);
    expect(html).toContain("npm i -g @tidegap/cli");
  });

  it("renders no button for prose without code", () => {
    expect(renderToStaticMarkup(<DocsProse html="<p>hi</p>" />)).not.toContain("Copy code");
  });

  it("gives every generated docs code block a button", () => {
    const blocks = DOCS_SECTIONS.flatMap((s) => s.blocks).flatMap((b) => ("html" in b ? [b.html] : []));
    const pres = blocks.join("").match(/<pre /g)?.length ?? 0;
    const buttons = blocks.map((h) => renderToStaticMarkup(<DocsProse html={h} />)).join("").match(/aria-label="Copy code"/g)?.length ?? 0;
    expect(pres).toBeGreaterThan(0);
    expect(buttons).toBe(pres);
  });
});
