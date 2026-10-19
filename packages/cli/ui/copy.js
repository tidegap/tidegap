// Click-to-copy chips (Settings → Integrations). The whole value is the
// button; a "Copy" label turns into "Copied" for 1.5 s. Values render as
// text nodes only.

import { h } from "./dom.js";
import { errorToast } from "./toast.js";

export const COPIED_MS = 1500;

/** Copy `text` to the clipboard; true when it worked. Falls back to a hidden textarea outside secure contexts. */
export async function copyText(text) {
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission refused: try the selection fallback below.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** A button showing `value` (or `shown`) that copies `value` on click. `what` names it for screen readers. */
export function copyChip(value, what, { shown = value, className = "" } = {}) {
  const label = h("span", { class: "copy-label", "aria-hidden": "true" }, "Copy");
  const chip = h("button", {
    type: "button",
    class: ["copy-chip", className],
    "data-copy": what,
    "aria-label": `Copy ${what}: ${value}`,
    title: `Copy ${what}`,
  }, h("span", { class: "copy-value" }, shown), label);
  let timer = null;
  chip.addEventListener("click", async () => {
    if (!(await copyText(value))) return void errorToast("Could not copy. Select the text and copy it.");
    clearTimeout(timer);
    chip.dataset.copied = "true";
    label.textContent = "Copied";
    timer = setTimeout(() => {
      delete chip.dataset.copied;
      label.textContent = "Copy";
    }, COPIED_MS);
  });
  return chip;
}
