import Link from "next/link";
import { BookingCta, ToothMark } from "./components/site-chrome";
import { clinic, hours, pricing, services } from "@/lib/content";

const highlights = [
  { label: "Open 7 days", detail: "Mon–Sat till 8 PM, Sundays till 2 PM" },
  { label: "Same-day emergencies", detail: "Slots held every single day" },
  { label: "Cashless insurance", detail: "Five insurers and two TPAs" },
  { label: "No-cost EMI", detail: "On treatment plans over ₹20,000" },
];

// A few signature prices for the teaser; the full list lives on /pricing.
const teaser = [
  { item: "New patient consultation", price: "₹500" },
  { item: "Scaling & polishing", price: "₹1,500" },
  { item: "Teeth whitening (in-clinic)", price: "₹8,000" },
  { item: "Dental implant", price: "₹35,000" },
];

export default function Home() {
  return (
    <>
      {/* ---- Hero ---- */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 right-[-10%] h-[520px] w-[520px] rounded-full bg-[var(--color-accent-wash)] blur-3xl"
        />
        <div className="rise relative mx-auto grid max-w-6xl gap-12 px-6 pt-20 pb-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-muted)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent-soft)]" />
              Indiranagar, Bengaluru · Open 7 days
            </p>
            <h1 className="display mt-5 text-[42px] leading-[1.08] sm:text-[56px]">
              Gentle, modern dentistry
              <br />
              <span className="text-[var(--color-accent)]">in Indiranagar.</span>
            </h1>
            <p className="mt-5 max-w-xl text-[17.5px] leading-relaxed text-[var(--color-muted)]">{clinic.intro}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/contact"
                className="rounded-full bg-[var(--color-accent)] px-6 py-3 text-[14.5px] font-semibold text-white transition-transform hover:scale-[1.02]"
              >
                Book an appointment
              </Link>
              <Link
                href="/pricing"
                className="rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-3 text-[14.5px] font-semibold text-[var(--color-ink)] transition-colors hover:bg-[var(--color-surface-2)]"
              >
                See our prices
              </Link>
            </div>
            <p className="mt-4 text-[13.5px] text-[var(--color-faint)]">
              Prefer to type? The chat bubble answers prices, hours and insurance questions instantly.
            </p>
          </div>

          {/* Hours card */}
          <div className="rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-7 shadow-[0_18px_50px_-24px_rgba(22,33,31,0.35)]">
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--color-accent-wash)] text-[var(--color-accent)]">
                <ToothMark className="h-5 w-5" />
              </span>
              <h2 className="display text-[19px]">Opening hours</h2>
            </div>
            <dl className="mt-5 space-y-3">
              {hours.rows.map((r) => (
                <div
                  key={r.days}
                  className="flex items-baseline justify-between gap-4 border-b border-dashed border-[var(--color-border)] pb-3 last:border-0 last:pb-0"
                >
                  <dt className="text-[14px] text-[var(--color-muted)]">{r.days}</dt>
                  <dd className="text-[14px] font-semibold text-[var(--color-ink)]">{r.time}</dd>
                </div>
              ))}
            </dl>
            <ul className="mt-5 space-y-2">
              {hours.notes.map((n) => (
                <li key={n} className="flex gap-2 text-[13px] leading-relaxed text-[var(--color-faint)]">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--color-accent-soft)]" />
                  {n}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ---- Highlights ---- */}
      <section className="mx-auto mt-14 max-w-6xl px-6">
        <div className="grid gap-px overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-4">
          {highlights.map((h) => (
            <div key={h.label} className="bg-[var(--color-surface)] p-6">
              <p className="text-[15px] font-semibold text-[var(--color-ink)]">{h.label}</p>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--color-muted)]">{h.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Services ---- */}
      <section className="mx-auto mt-24 max-w-6xl px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--color-accent)]">
              What we do
            </p>
            <h2 className="display mt-3 text-[34px] leading-tight">Care for every stage.</h2>
          </div>
          <Link href="/services" className="text-[14px] font-semibold text-[var(--color-accent)] hover:underline">
            All services →
          </Link>
        </div>

        <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {services.map((s) => (
            <article
              key={s.title}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 transition-shadow hover:shadow-[0_16px_40px_-24px_rgba(22,33,31,0.4)]"
            >
              <h3 className="display text-[18px] text-[var(--color-ink)]">{s.title}</h3>
              <p className="mt-2.5 text-[14px] leading-relaxed text-[var(--color-muted)]">{s.blurb}</p>
              <ul className="mt-4 flex flex-wrap gap-1.5">
                {s.items.slice(0, 3).map((i) => (
                  <li
                    key={i}
                    className="rounded-full bg-[var(--color-surface-2)] px-2.5 py-1 text-[12px] text-[var(--color-muted)]"
                  >
                    {i}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      {/* ---- Pricing teaser ---- */}
      <section className="mx-auto mt-24 max-w-6xl px-6">
        <div className="grid gap-10 rounded-3xl bg-[var(--color-sand)] px-8 py-12 sm:px-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--color-accent)]">
              Clear pricing
            </p>
            <h2 className="display mt-3 text-[32px] leading-tight">No surprises at the desk.</h2>
            <p className="mt-4 text-[15.5px] leading-relaxed text-[var(--color-muted)]">
              Every price is published up front. These are indicative starting prices — the final cost is confirmed
              after an in-person consultation, and we&apos;ll always talk you through it first.
            </p>
            <Link
              href="/pricing"
              className="mt-6 inline-block rounded-full bg-[var(--color-ink)] px-5 py-2.5 text-[14px] font-semibold text-white transition-transform hover:scale-[1.02]"
            >
              View the full price list
            </Link>
          </div>

          <ul className="rounded-2xl bg-[var(--color-surface)] px-6">
            {teaser.map((t) => (
              <li
                key={t.item}
                className="flex items-baseline justify-between gap-6 border-b border-[var(--color-border)] py-4"
              >
                <span className="text-[14.5px] text-[var(--color-muted)]">{t.item}</span>
                <span className="display text-[17px] text-[var(--color-ink)]">{t.price}</span>
              </li>
            ))}
            <li className="py-4 text-[12.5px] text-[var(--color-faint)]">
              {pricing.length} categories in total · No-cost EMI above ₹20,000
            </li>
          </ul>
        </div>
      </section>

      <BookingCta />
    </>
  );
}
