import { InstallPicker } from "@/components/install-picker";
import type { DocsEmbedName } from "@/lib/docs.generated";

/** Embeds the page renders as components. The generator resolves every other embed to HTML. */
export function DocsEmbed({ name }: { name: DocsEmbedName }) {
  switch (name) {
    case "install-picker":
      return (
        <div className="my-6 rounded-xl border border-accent/30 bg-accent/[0.03] p-5 sm:p-7">
          <InstallPicker />
        </div>
      );
  }
}
