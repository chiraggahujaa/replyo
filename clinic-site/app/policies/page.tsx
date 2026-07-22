import type { Metadata } from "next";
import { BookingCta, PageHeader } from "../components/site-chrome";
import { insurers, policies, tpas } from "@/lib/content";

export const metadata: Metadata = {
  title: "Patient information",
  description:
    "Insurance and cashless cover, cancellation policy, payment options, what to bring as a new patient, and how we handle your data.",
};

export default function PoliciesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Patient information"
        title="The practical details."
        lede="Insurance, cancellations, payment and what to bring on your first visit — all in one place, so there's nothing to find out the hard way."
      />

      {/* Insurers */}
      <section className="mx-auto max-w-4xl px-6">
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-7">
          <h2 className="display text-[20px]">Cashless treatment</h2>
          <p className="mt-2.5 text-[14.5px] leading-relaxed text-[var(--color-muted)]">
            Where your plan includes dental / OPD cover, we&apos;re empanelled with:
          </p>
          <ul className="mt-5 flex flex-wrap gap-2">
            {insurers.map((name) => (
              <li
                key={name}
                className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3.5 py-1.5 text-[13.5px] text-[var(--color-ink)]"
              >
                {name}
              </li>
            ))}
          </ul>
          <p className="mt-5 text-[13px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">
            Cashless via TPAs
          </p>
          <ul className="mt-2.5 flex flex-wrap gap-2">
            {tpas.map((name) => (
              <li
                key={name}
                className="rounded-full border border-[var(--color-border)] bg-[var(--color-accent-wash)] px-3.5 py-1.5 text-[13.5px] text-[var(--color-accent)]"
              >
                {name}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Policies */}
      <section className="mx-auto mt-8 max-w-4xl px-6">
        <div className="divide-y divide-[var(--color-border)] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {policies.map((p) => (
            <article key={p.title} className="grid gap-3 p-7 sm:grid-cols-[190px_1fr]">
              <h2 className="display text-[18px]">{p.title}</h2>
              <div className="space-y-3">
                {p.body.map((para) => (
                  <p key={para} className="text-[14.5px] leading-relaxed text-[var(--color-muted)]">
                    {para}
                  </p>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <BookingCta />
    </>
  );
}
