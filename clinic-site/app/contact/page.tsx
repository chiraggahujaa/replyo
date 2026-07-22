import type { Metadata } from "next";
import { PageHeader, ToothMark } from "../components/site-chrome";
import { clinic, hours } from "@/lib/content";

export const metadata: Metadata = {
  title: "Visit us",
  description: `Opening hours, address and contact details for ${clinic.name} in Indiranagar, Bengaluru.`,
};

export default function ContactPage() {
  const tel = clinic.phone.replace(/\s/g, "");

  return (
    <>
      <PageHeader
        eyebrow="Visit us"
        title="Find us in Indiranagar."
        lede="Two minutes off 100 Feet Road, five minutes' walk from the metro, with validated parking if you're driving."
      />

      <section className="mx-auto max-w-6xl px-6">
        <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
          {/* Address + contact */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-7">
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--color-accent-wash)] text-[var(--color-accent)]">
                <ToothMark className="h-5 w-5" />
              </span>
              <h2 className="display text-[20px]">{clinic.name}</h2>
            </div>

            <address className="mt-5 text-[15px] not-italic leading-relaxed text-[var(--color-muted)]">
              {clinic.address.line1}
              <br />
              {clinic.address.line2}
              <br />
              {clinic.address.city}
              <br />
              {clinic.address.country}
            </address>

            <dl className="mt-6 space-y-3 border-t border-dashed border-[var(--color-border)] pt-6">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-[14px] text-[var(--color-faint)]">Phone / WhatsApp</dt>
                <dd>
                  <a
                    href={`tel:${tel}`}
                    className="text-[14.5px] font-semibold text-[var(--color-accent)] hover:underline"
                  >
                    {clinic.phone}
                  </a>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-[14px] text-[var(--color-faint)]">Email</dt>
                <dd>
                  <a
                    href={`mailto:${clinic.email}`}
                    className="text-[14.5px] font-semibold text-[var(--color-accent)] hover:underline"
                  >
                    {clinic.email}
                  </a>
                </dd>
              </div>
            </dl>

            <ul className="mt-6 space-y-2.5 border-t border-dashed border-[var(--color-border)] pt-6">
              <li className="flex gap-2.5 text-[14px] text-[var(--color-muted)]">
                <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent-soft)]" />
                {clinic.parking}
              </li>
              <li className="flex gap-2.5 text-[14px] text-[var(--color-muted)]">
                <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent-soft)]" />
                Nearest metro: {clinic.metro}
              </li>
            </ul>
          </div>

          {/* Hours */}
          <div className="rounded-2xl bg-[var(--color-ink)] p-7 text-white">
            <h2 className="display text-[20px]">Opening hours</h2>
            <dl className="mt-5 space-y-4">
              {hours.rows.map((r) => (
                <div key={r.days} className="border-b border-white/10 pb-4 last:border-0 last:pb-0">
                  <dt className="text-[13px] uppercase tracking-wider text-white/50">{r.days}</dt>
                  <dd className="display mt-1 text-[19px]">{r.time}</dd>
                </div>
              ))}
            </dl>
            <ul className="mt-6 space-y-2 rounded-xl bg-white/5 p-4">
              {hours.notes.map((n) => (
                <li key={n} className="text-[13px] leading-relaxed text-white/70">
                  {n}
                </li>
              ))}
            </ul>
            <p className="mt-6 text-[13.5px] leading-relaxed text-white/60">
              In pain right now? Call us as early in the day as you can — we hold emergency slots every day.
            </p>
          </div>
        </div>

        {/* Booking prompt */}
        <div className="mt-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-accent-wash)] p-7">
          <h2 className="display text-[20px]">Booking an appointment</h2>
          <p className="mt-2.5 max-w-3xl text-[14.5px] leading-relaxed text-[var(--color-muted)]">
            Call or email us, or just open the chat bubble in the corner — the assistant can check availability and
            book you in. New patients: please arrive 10 minutes early to complete a medical history form, and bring
            a government photo ID plus your insurance or TPA card if you have one.
          </p>
        </div>
      </section>
    </>
  );
}
