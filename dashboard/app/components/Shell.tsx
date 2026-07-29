"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useReplyo } from "../providers";
import { Splash } from "./ui";
import { ThemeToggle } from "./ThemeToggle";
import {
  BookIcon,
  CheckIcon,
  ChevronDownIcon,
  CodeIcon,
  InboxIcon,
  LogoutIcon,
  PlusIcon,
  SparkIcon,
  UsersIcon,
} from "./icons";

const NAV = [
  { href: "/queue", label: "Review queue", icon: InboxIcon },
  { href: "/personas", label: "Personas", icon: UsersIcon },
  { href: "/knowledge", label: "Knowledge", icon: BookIcon },
  { href: "/install", label: "Install", icon: CodeIcon },
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
    // Pin the console to exactly one viewport so ONLY the content pane scrolls. Without a
    // fixed height here the body just grows with the page and the sidebar scrolls away
    // with it. 100dvh (not 100vh) so mobile browser chrome doesn't cause a phantom scroll.
    <div className="flex h-[100dvh] overflow-hidden">
      <Sidebar />
      <main className="flex flex-1 flex-col min-h-0 bg-[var(--color-bg)] overflow-y-auto">{children}</main>
    </div>
  );
}

function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="glass h-full w-[248px] shrink-0 border-r border-[var(--color-border)] flex flex-col">
      <div className="flex items-center gap-3 px-5 py-5 border-b border-[var(--color-border)]">
        <div className="animate-float grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-cta text-white glow-accent">
          <SparkIcon className="h-5 w-5" />
        </div>
        <div className="leading-tight">
          <div className="font-display text-[17px] font-semibold tracking-tight">Replyo</div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">
            Console
          </div>
        </div>
      </div>

      <PersonaSwitcher />

      {/* flex-1 + min-h-0 so a long nav scrolls inside the sidebar rather than pushing
          the account footer off the bottom. */}
      <nav className="flex flex-1 min-h-0 flex-col gap-1 overflow-y-auto px-3 py-3">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`relative flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[14px] transition-all duration-200 ${
                active
                  ? "bg-[var(--accent-wash)] font-semibold text-[var(--color-accent-ink)]"
                  : "font-medium text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] hover:translate-x-0.5"
              }`}
            >
              {active && (
                <span
                  className="absolute left-0 top-1/2 h-4 w-1 -translate-y-1/2 rounded-full bg-cta"
                  aria-hidden
                />
              )}
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto">
        <SidebarFooter />
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
    <div ref={ref} className="relative px-3 py-3.5 border-b border-[var(--color-border)]">
      <div className="px-1.5 pb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">
        Persona
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-left transition-all duration-200 hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <span className="truncate text-[14px] font-semibold">{active ? active.name : "No personas yet"}</span>
        <ChevronDownIcon
          className={`h-4 w-4 shrink-0 text-[var(--color-faint)] transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        // OPAQUE surface, not `glass`: --glass is only ~70% alpha, so the nav links
        // underneath showed straight through the menu. Popovers that overlay content
        // need a solid background; the blur alone isn't enough to separate the layers.
        <div className="animate-pop absolute left-3 right-3 z-20 mt-1.5 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
          {personas.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setActiveId(p.id);
                setOpen(false);
              }}
              className={`w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left text-[14px] transition-colors hover:bg-[var(--accent-wash)] ${
                active?.id === p.id ? "font-semibold text-[var(--color-accent-ink)]" : "text-[var(--color-text)]"
              }`}
            >
              <span className="truncate">{p.name}</span>
              {active?.id === p.id && <CheckIcon className="h-3.5 w-3.5 shrink-0" />}
            </button>
          ))}
          <Link
            href="/personas/new"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 border-t border-[var(--color-border)] px-4 py-2.5 text-[14px] font-semibold text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--accent-wash)]"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            New persona
          </Link>
        </div>
      )}
    </div>
  );
}

function SidebarFooter() {
  const { session, signOut } = useReplyo();
  const router = useRouter();
  const email = session?.user?.email ?? "";
  return (
    <div className="border-t border-[var(--color-border)]">
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">
          Theme
        </span>
        <ThemeToggle />
      </div>
      <div className="flex items-center gap-2.5 px-4 pb-4 pt-1.5">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-cta text-[11px] font-semibold uppercase text-white">
          {email ? email[0].toUpperCase() : "?"}
        </div>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-muted)]">{email}</span>
        <button
          onClick={async () => {
            await signOut();
            router.replace("/login");
          }}
          title="Sign out"
          aria-label="Sign out"
          className="shrink-0 rounded-full p-1.5 text-[var(--color-faint)] transition-colors hover:bg-[var(--danger-wash)] hover:text-[var(--color-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          <LogoutIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
