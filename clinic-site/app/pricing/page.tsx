import type { Metadata } from "next";
import { BookingCta, PageHeader } from "../components/site-chrome";
import { pricing } from "@/lib/content";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Indicative starting prices for consultations, cleaning, cosmetic, restorative and orthodontic treatment at BrightSmile Dental.",
};

export default function PricingPage() {
  return (
    <>
      <PageHeader
        eyebrow="Pricing"
        title="Published prices, start to finish."
        lede="All prices are in INR and are indicative starting prices. Final costs are confirmed after an in-person consultation — you'll never be surprised by a number you haven't seen."
      />

      <section className="mx-auto max-w-4xl px-6">
        <div className="space-y-10">
          {pricing.map((group) => (
            <div key={group.group}>
              <h2 className="display text-[22px]">{group.group}</h2>
              <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
                <table className="w-full text-left">
                  <caption className="sr-only">{group.group} prices</caption>
                  <tbody>
                    {group.rows.map((row) => (
                      <tr key={row.item} className="border-b border-[var(--color-border)] last:border-0">
                        <th scope="row" className="px-5 py-4 text-[14.5px] font-normal text-[var(--color-ink)]">
                          {row.item}
                          {row.note ? (
                            <span className="mt-0.5 block text-[12.5px] text-[var(--color-faint)]">{row.note}</span>
                          ) : null}
                        </th>
                        <td className="display whitespace-nowrap px-5 py-4 text-right text-[16px] text-[var(--color-ink)]">
                          {row.price}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>

        <aside className="mt-10 rounded-2xl bg-[var(--color-sand)] p-7">
          <h2 className="display text-[19px]">Paying for treatment</h2>
          <p className="mt-2.5 text-[14.5px] leading-relaxed text-[var(--color-muted)]">
            We accept cash, UPI, all major credit and debit cards, and bank transfer.{" "}
            <strong className="font-semibold text-[var(--color-ink)]">
              No-cost EMI and payment plans are available for treatment plans above ₹20,000
            </strong>
            , subject to approval. We&apos;re also empanelled for cashless treatment with several insurers — see{" "}
            <a href="/policies" className="font-semibold text-[var(--color-accent)] hover:underline">
              patient information
            </a>{" "}
            for the full list.
          </p>
        </aside>
      </section>

      <BookingCta />
    </>
  );
}
