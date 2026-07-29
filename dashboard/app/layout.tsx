import type { Metadata } from "next";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { ReplyoProvider } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Replyo · Console",
  description: "Build AI assistants for your business — knowledge, personas, and a human-review queue.",
};

/* Resolves the theme to a concrete light/dark BEFORE first paint (no flash): stored
   preference wins, otherwise the OS preference. ThemeToggle writes the same key. */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("replyo:theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      {/* suppressHydrationWarning: browser extensions (ColorZilla, Grammarly, etc.)
          inject attributes like cz-shortcut-listen onto <body> before React hydrates,
          which would otherwise flag a benign server/client attribute mismatch. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <div className="aurora" aria-hidden />
        <div className="aurora-grid" aria-hidden />
        <ReplyoProvider>{children}</ReplyoProvider>
      </body>
    </html>
  );
}
