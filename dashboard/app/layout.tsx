import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Replyo · Console",
  description: "Build AI assistants for your business — knowledge, personas, and a human-review queue.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* suppressHydrationWarning: browser extensions (ColorZilla, Grammarly, etc.)
          inject attributes like cz-shortcut-listen onto <body> before React hydrates,
          which would otherwise flag a benign server/client attribute mismatch. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <ReplyoProvider>{children}</ReplyoProvider>
      </body>
    </html>
  );
}
