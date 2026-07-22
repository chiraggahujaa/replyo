import type { Metadata } from "next";
import { BookingCta, PageHeader } from "../components/site-chrome";
import { services } from "@/lib/content";

export const metadata: Metadata = {
  title: "Services",
  description:
    "General, cosmetic, restorative, paediatric and emergency dentistry, plus orthodontics — everything BrightSmile Dental offers.",
};

export default function ServicesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Services"
        title="Everything we do, in plain language."
        lede="No jargon and no upselling. If a treatment isn't right for you, we'll say so — and if it is, we'll explain exactly what it involves before you agree to anything."
      />

      <section className="mx-auto max-w-6xl px-6">
        <div className="grid gap-6 md:grid-cols-2">
          {services.map((s, i) => (
            <article
              key={s.title}
              className="flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-7"
            >
              <div className="flex items-baseline gap-3">
                <span className="display text-[13px] text-[var(--color-accent)]">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h2 className="display text-[21px]">{s.title}</h2>
              </div>
              <p className="mt-3 text-[14.5px] leading-relaxed text-[var(--color-muted)]">{s.blurb}</p>
              <ul className="mt-5 space-y-2 border-t border-dashed border-[var(--color-border)] pt-5">
                {s.items.map((item) => (
                  <li key={item} className="flex gap-2.5 text-[14px] text-[var(--color-ink)]">
                    <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent-soft)]" />
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <BookingCta />
    </>
  );
}
