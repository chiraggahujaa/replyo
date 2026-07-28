import type { Metadata } from "next";
import Script from "next/script";
import { Fraunces, Geist } from "next/font/google";
import "./globals.css";
import { SiteFooter, SiteHeader } from "./components/site-chrome";
import { clinic } from "@/lib/content";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// A soft display serif for headings — warmer than a grotesk for a care setting.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: `${clinic.name} — ${clinic.tagline}`,
    template: `%s · ${clinic.name}`,
  },
  description: clinic.intro,
};

// Where the Replyo API lives. Set NEXT_PUBLIC_REPLYO_API in .env.local to point the
// widget at a deployed backend; defaults to the local dev API.
const REPLYO_API = process.env.NEXT_PUBLIC_REPLYO_API ?? "http://localhost:8000";
// The BrightSmile demo persona's public key (seeded by the multitenancy migration).
const REPLYO_TENANT = process.env.NEXT_PUBLIC_REPLYO_TENANT ?? "pk_demo_brightsmile";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${fraunces.variable} h-full antialiased`}>
      {/* suppressHydrationWarning: browser extensions inject attributes onto <body>
          before hydration, which would otherwise flag a benign mismatch. */}
      <body className="flex min-h-full flex-col font-sans" suppressHydrationWarning>
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />

        {/*
          The Replyo assistant — the entire integration is this one tag. It's served
          by the FastAPI backend and isolates itself in a Shadow DOM, so the same
          tag drops onto any site; nothing about it is Next.js-specific.
        */}
        <Script
          src={`${REPLYO_API}/widget/widget.js`}
          data-api={REPLYO_API}
          data-tenant={REPLYO_TENANT}
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
