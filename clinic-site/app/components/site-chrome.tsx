import Link from "next/link";
import { clinic, hours, nav } from "@/lib/content";

export function ToothMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 3.2c-1.5 0-2.2.6-3.6.6-1.5 0-2.6-.6-3.6.4-1.1 1.1-1 3.2-.5 5.6.4 1.9.6 2.6.9 4.6.3 2 .5 4.2.8 5.2.3 1 .8 1.6 1.5 1.6 1 0 1.3-1 1.6-2.6.3-1.5.5-3.2 1.4-3.2s1.1 1.7 1.4 3.2c.3 1.6.6 2.6 1.6 2.6.7 0 1.2-.6 1.5-1.6.3-1 .5-3.2.8-5.2.3-2 .5-2.7.9-4.6.5-2.4.6-4.5-.5-5.6-1-1-2.1-.4-3.6-.4-1.4 0-2.1-.6-3.6-.6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_88%,transparent)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--color-accent)] text-white">
            <ToothMark className="h-5 w-5" />
          </span>
          <span className="display text-[17px] leading-none">{clinic.name}</span>
        </Link>

        <nav className="hidden items-center gap-7 md:flex">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-[14px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-ink)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <a
          href={`tel:${clinic.phone.replace(/\s/g, "")}`}
          className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-[13.5px] font-semibold text-white transition-colors hover:bg-[var(--color-accent-soft)]"
        >
          Call {clinic.phone}
        </a>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--color-accent)] text-white">
              <ToothMark className="h-4.5 w-4.5" />
            </span>
            <span className="display text-[15px]">{clinic.name}</span>
          </div>
          <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--color-muted)]">{clinic.tagline}.</p>
        </div>

        <div>
          <h4 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">Visit</h4>
          <address className="mt-3 text-[13.5px] not-italic leading-relaxed text-[var(--color-muted)]">
            {clinic.address.line1}
            <br />
            {clinic.address.line2}
            <br />
            {clinic.address.city}
          </address>
        </div>

        <div>
          <h4 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">Hours</h4>
          <ul className="mt-3 space-y-1.5 text-[13.5px] text-[var(--color-muted)]">
            {hours.rows.map((r) => (
              <li key={r.days}>
                <span className="text-[var(--color-ink)]">{r.days}</span>
                <br />
                {r.time}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h4 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">Contact</h4>
          <ul className="mt-3 space-y-1.5 text-[13.5px] text-[var(--color-muted)]">
            <li>
              <a className="hover:text-[var(--color-ink)]" href={`tel:${clinic.phone.replace(/\s/g, "")}`}>
                {clinic.phone}
              </a>
            </li>
            <li>
              <a className="hover:text-[var(--color-ink)]" href={`mailto:${clinic.email}`}>
                {clinic.email}
              </a>
            </li>
            <li className="pt-1 text-[var(--color-faint)]">{clinic.metro}</li>
          </ul>
        </div>
      </div>

      <div className="border-t border-[var(--color-border)] px-6 py-5">
        <p className="mx-auto max-w-6xl text-[12.5px] text-[var(--color-faint)]">
          A demonstration site for <strong className="font-semibold text-[var(--color-muted)]">Replyo</strong> — the
          chat bubble is a live AI assistant answering from this clinic&apos;s own documents. Not a real practice.
        </p>
      </div>
    </footer>
  );
}

/** Page heading used at the top of every inner page. */
export function PageHeader({ eyebrow, title, lede }: { eyebrow: string; title: string; lede?: string }) {
  return (
    <div className="rise mx-auto max-w-6xl px-6 pt-16 pb-10">
      <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--color-accent)]">{eyebrow}</p>
      <h1 className="display mt-3 text-[38px] leading-[1.12] sm:text-[46px]">{title}</h1>
      {lede ? (
        <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-[var(--color-muted)]">{lede}</p>
      ) : null}
    </div>
  );
}

/** Shared bottom-of-page call to action. */
export function BookingCta() {
  return (
    <section className="mx-auto mt-20 max-w-6xl px-6">
      <div className="overflow-hidden rounded-3xl bg-[var(--color-accent)] px-8 py-12 text-white sm:px-12">
        <div className="max-w-2xl">
          <h2 className="display text-[30px] leading-tight sm:text-[34px]">Ready when you are.</h2>
          <p className="mt-3 text-[16px] leading-relaxed text-white/85">
            Book a visit, ask about a treatment, or check whether we take your insurance — the assistant in the
            corner answers instantly, and a person picks it up whenever it matters.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a
              href={`tel:${clinic.phone.replace(/\s/g, "")}`}
              className="rounded-full bg-white px-5 py-2.5 text-[14px] font-semibold text-[var(--color-accent)] transition-transform hover:scale-[1.02]"
            >
              Call {clinic.phone}
            </a>
            <a
              href={`mailto:${clinic.email}`}
              className="rounded-full border border-white/35 px-5 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-white/10"
            >
              Email us
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
