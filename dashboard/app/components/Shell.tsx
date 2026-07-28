"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useReplyo } from "../providers";
import { InboxIcon, SparkIcon } from "./icons";

const NAV = [
  { href: "/", label: "Review queue" },
  { href: "/personas", label: "Personas" },
  { href: "/knowledge", label: "Knowledge" },
  { href: "/install", label: "Install" },
];

/** Wraps every authenticated page: redirects to /login when signed out, and renders the
 *  sidebar + persona switcher around the page content. */
export function Shell({ children }: { children: React.ReactNode }) {
  const { session, ready } = useReplyo();
  const router = useRouter();

  useEffect(() => {
    if (ready && !session) router.replace("/login");
  }, [ready, session, router]);

  if (!ready) return <Splash />;
  if (!session) return <Splash />; // redirecting

  return (
    <div className="flex flex-1 min-h-0">
      <Sidebar />
      <main className="flex flex-1 flex-col min-h-0 bg-[var(--color-bg)] overflow-y-auto">{children}</main>
    </div>
  );
}

function Splash() {
  return (
    <div className="flex flex-1 items-center justify-center text-[var(--color-faint)] text-[13px]">Loading…</div>
  );
}

function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-[236px] shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg-soft)] flex flex-col">
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[var(--color-border)]">
        <div className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-sm">
          <SparkIcon className="w-[18px] h-[18px]" />
        </div>
        <div className="leading-tight">
          <div className="text-[14px] font-semibold tracking-tight">Replyo</div>
          <div className="text-[11px] text-[var(--color-faint)]">Console</div>
        </div>
      </div>

      <PersonaSwitcher />

      <nav className="flex flex-col gap-0.5 px-2.5 py-2">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors ${
                active
                  ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm border border-[var(--color-border)]"
                  : "text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto">
        <AccountFooter />
      </div>
    </aside>
  );
}

function PersonaSwitcher() {
  const { personas, active, setActiveId } = useReplyo();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={ref} className="relative px-3 py-3 border-b border-[var(--color-border)]">
      <div className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">
        Persona
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left hover:border-[var(--color-border-strong)]"
      >
        <span className="truncate text-[13.5px] font-semibold">{active ? active.name : "No personas yet"}</span>
        <svg className="w-4 h-4 text-[var(--color-faint)] shrink-0" viewBox="0 0 24 24" fill="none">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-3 right-3 z-20 mt-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg overflow-hidden">
          {personas.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setActiveId(p.id);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-[13px] hover:bg-[var(--color-bg-soft)] ${
                active?.id === p.id ? "text-[var(--color-accent-ink)] font-semibold" : "text-[var(--color-text)]"
              }`}
            >
              {p.name}
            </button>
          ))}
          <Link
            href="/personas/new"
            onClick={() => setOpen(false)}
            className="block border-t border-[var(--color-border)] px-3 py-2 text-[13px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-bg-soft)]"
          >
            ＋ New persona
          </Link>
        </div>
      )}
    </div>
  );
}

function AccountFooter() {
  const { session, signOut } = useReplyo();
  const router = useRouter();
  const email = session?.user?.email ?? "";
  return (
    <div className="border-t border-[var(--color-border)] px-4 py-3 flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
          <InboxIcon className="w-3.5 h-3.5" />
          <span className="truncate">{email}</span>
        </div>
      </div>
      <button
        onClick={async () => {
          await signOut();
          router.replace("/login");
        }}
        className="text-[11px] font-medium text-[var(--color-faint)] hover:text-rose-500"
      >
        Sign out
      </button>
    </div>
  );
}
