import type { ReactNode } from "react";

type SectionProps = {
  id: string;
  eyebrow: string;
  title: ReactNode;
  /** At most one sentence. */
  lead?: ReactNode;
  children?: ReactNode;
};

/** The shared homepage section shell: eyebrow, H2, optional lead, then the visual. */
export function Section({ id, eyebrow, title, lead, children }: SectionProps) {
  return (
    <section id={id} className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <header className="max-w-2xl">
          <p className="type-eyebrow">{eyebrow}</p>
          <h2 className="type-h2 mt-3 text-fg">{title}</h2>
          {lead ? <p className="mt-4 text-base text-fg-muted">{lead}</p> : null}
        </header>
        {children ? <div className="mt-10">{children}</div> : null}
      </div>
    </section>
  );
}
