"use client";

// Public landing page — the signed-out front door. The console lives under /queue
// (+ /personas, /knowledge, /install). Signed-in visitors are forwarded straight to
// the console: logging in (including the OAuth round-trip, which may bounce off this
// page) must always end in the app, never on marketing.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useReplyo } from "./providers";
import { Badge, Button, Card, TypingDots } from "./components/ui";
import { ThemeToggle } from "./components/ThemeToggle";
import {
  ArrowRightIcon,
  BookIcon,
  CheckIcon,
  CodeIcon,
  InboxIcon,
  RefreshIcon,
  RocketIcon,
  SendIcon,
  SparkIcon,
  UsersIcon,
  WandIcon,
} from "./components/icons";

const FEATURES = [
  {
    icon: BookIcon,
    title: "Self-serve knowledge",
    text: "Upload documents or point Replyo at your website — it deep-crawls every page and answers only from what's true for your business.",
  },
  {
    icon: UsersIcon,
    title: "One login, many personas",
    text: "Every business gets its own assistant: separate knowledge, prompt, embed key and review queue, isolated end to end.",
  },
  {
    icon: InboxIcon,
    title: "Human in the loop",
    text: "Risky or upset conversations pause for you. Approve, edit or reject drafts from a live review queue — your word is always final.",
  },
  {
    icon: CodeIcon,
    title: "One-tag install",
    text: "Paste a single script tag on any site. Pick a name, theme, size and corner in the console — every embed restyles itself on its next load.",
  },
  {
    icon: SendIcon,
    title: "Live streaming replies",
    text: "Answers stream token by token over websockets, with a graceful HTTP fallback when a network gets in the way.",
  },
  {
    icon: RefreshIcon,
    title: "Follow-ups that convert",
    text: "Leads that go quiet get a scheduled re-engagement nudge after 48 hours — automatically, on the channel they used.",
  },
];

const STEPS = [
  {
    icon: WandIcon,
    title: "Create a persona",
    text: "Name your assistant, then feed it documents and your website. Ingestion runs in the background.",
  },
  {
    icon: CheckIcon,
    title: "Approve its instructions",
    text: "Replyo drafts the system prompt from your knowledge. You review, edit and save — nothing ships without you.",
  },
  {
    icon: RocketIcon,
    title: "Embed one tag",
    text: "Style the widget, copy the snippet, paste it anywhere. You're live — escalations land in your queue.",
  },
];

export default function LandingPage() {
  const { session, ready } = useReplyo();
  const router = useRouter();
  const signedIn = ready && !!session;
  const ctaHref = signedIn ? "/queue" : "/login";
  const ctaLabel = signedIn ? "Open console" : "Get started free";

  // Signed in -> console, always. The landing renders immediately for everyone else
  // (no splash gate), so anonymous visitors — the common case — never wait on auth.
  useEffect(() => {
    if (ready && session) router.replace("/queue");
  }, [ready, session, router]);

  return (
    <div className="flex min-h-[100dvh] flex-col">
      {/* ---- nav ---- */}
      <header className="glass sticky top-0 z-40 border-b border-[var(--color-border)]">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-cta text-white glow-accent">
              <SparkIcon className="h-4.5 w-4.5" />
            </div>
            <span className="font-display text-[17px] font-semibold tracking-tight">Replyo</span>
          </div>
          <div className="flex items-center gap-2.5">
            <ThemeToggle />
            {!signedIn && (
              <Button variant="ghost" size="sm" href="/login" className="hidden sm:inline-flex">
                Sign in
              </Button>
            )}
            <Button size="sm" href={ctaHref} icon={<ArrowRightIcon className="h-3.5 w-3.5" />}>
              {ctaLabel}
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* ---- hero ---- */}
        <section className="mx-auto w-full max-w-6xl px-6 pb-24 pt-16 text-center sm:pt-24">
          <div className="animate-in mx-auto max-w-3xl">
            <Badge tone="accent" pulse className="animate-pop">
              Human-approved AI · live in minutes
            </Badge>
            <h1 className="mt-6 font-display text-[42px] font-semibold leading-[1.05] tracking-tight sm:text-[60px]">
              Meet your business&rsquo;s
              <span className="text-gradient-animated block">AI front desk</span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-[16px] leading-relaxed text-[var(--color-muted)] sm:text-[17px]">
              Replyo answers customers from your own knowledge, streams replies live on your
              website, and hands the tricky conversations to you — one approval away. One tag to
              install, nothing to maintain.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Button size="lg" href={ctaHref} icon={<RocketIcon className="h-4.5 w-4.5" />}>
                {ctaLabel}
              </Button>
              <Button variant="secondary" size="lg" href="#features">
                Explore features
              </Button>
            </div>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-2.5">
              {["One-tag install", "Streams live", "Human in the loop", "Always on"].map((s) => (
                <span
                  key={s}
                  className="glass rounded-full border border-[var(--color-border)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--color-muted)]"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>

          <ChatMock />
        </section>

        {/* ---- features ---- */}
        <section id="features" className="mx-auto w-full max-w-6xl scroll-mt-20 px-6 py-20">
          <div className="animate-in mx-auto max-w-2xl text-center">
            <Badge tone="accent">Everything included</Badge>
            <h2 className="mt-4 font-display text-[30px] font-semibold tracking-tight sm:text-[36px]">
              A complete front desk, <span className="text-gradient">not just a chatbot</span>
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-[var(--color-muted)]">
              From ingesting your knowledge to the moment a human signs off on a delicate reply —
              every step is built in.
            </p>
          </div>
          <div className="stagger mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <Card key={f.title} hover className="animate-in p-6">
                  <div className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--accent-wash)] text-[var(--color-accent-ink)]">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 font-display text-[17px] font-semibold tracking-tight">
                    {f.title}
                  </h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-[var(--color-muted)]">
                    {f.text}
                  </p>
                </Card>
              );
            })}
          </div>
        </section>

        {/* ---- how it works ---- */}
        <section className="mx-auto w-full max-w-5xl px-6 py-20">
          <div className="animate-in mx-auto max-w-2xl text-center">
            <Badge tone="accent">How it works</Badge>
            <h2 className="mt-4 font-display text-[30px] font-semibold tracking-tight sm:text-[36px]">
              Live in three steps
            </h2>
          </div>
          <div className="stagger relative mt-12 grid gap-10 sm:grid-cols-3 sm:gap-6">
            {/* connector rail behind the orbs (desktop only) */}
            <div
              className="absolute left-[16%] right-[16%] top-7 hidden h-0.5 rounded-full bg-[var(--color-border)] sm:block"
              aria-hidden
            />
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              return (
                <div key={s.title} className="animate-in relative text-center">
                  <div className="glow-accent relative mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-cta text-white">
                    <Icon className="h-6 w-6" />
                    <span className="absolute -right-1.5 -top-1.5 grid h-5.5 w-5.5 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[11px] font-bold text-[var(--color-accent-ink)]">
                      {i + 1}
                    </span>
                  </div>
                  <h3 className="mt-5 font-display text-[17px] font-semibold tracking-tight">
                    {s.title}
                  </h3>
                  <p className="mx-auto mt-2 max-w-[280px] text-[14px] leading-relaxed text-[var(--color-muted)]">
                    {s.text}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* ---- final CTA ---- */}
        <section className="mx-auto w-full max-w-4xl px-6 py-20">
          <div className="animate-in rounded-3xl bg-cta p-[1px] glow-accent-lg">
            <div className="rounded-[calc(1.5rem-1px)] bg-[var(--color-surface)] px-8 py-12 text-center sm:px-14">
              <div className="animate-float mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-cta text-white glow-accent">
                <SparkIcon className="h-7 w-7" />
              </div>
              <h2 className="mt-6 font-display text-[28px] font-semibold tracking-tight sm:text-[34px]">
                Put your front desk on <span className="text-gradient">autopilot</span>
              </h2>
              <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-[var(--color-muted)]">
                Create a persona, feed it your knowledge, embed one tag. Your customers get
                instant answers — you keep the final word.
              </p>
              <div className="mt-8 flex justify-center">
                <Button size="lg" href={ctaHref} icon={<ArrowRightIcon className="h-4.5 w-4.5" />}>
                  {ctaLabel}
                </Button>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ---- footer ---- */}
      <footer className="border-t border-[var(--color-border)]">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-7">
          <div className="flex items-center gap-2 text-[13px] text-[var(--color-muted)]">
            <SparkIcon className="h-4 w-4 text-[var(--color-accent-ink)]" />
            <span className="font-semibold text-[var(--color-text)]">Replyo</span>
            <span aria-hidden>·</span>
            <span>AI assistants with a human in the loop</span>
          </div>
          <span className="text-[12.5px] text-[var(--color-faint)]">© 2026 Replyo</span>
        </div>
      </footer>
    </div>
  );
}

/* ---- hero visual: a self-contained animated widget mock ---------------------------- */

function ChatMock() {
  return (
    <div className="relative mx-auto mt-16 w-full max-w-[400px]">
      {/* soft brand glow bleeding out behind the panel */}
      <div className="absolute -inset-8 rounded-[40px] bg-cta opacity-20 blur-3xl" aria-hidden />

      <Card className="animate-float relative overflow-hidden p-0 text-left shadow-2xl">
        <div className="bg-cta flex items-center justify-between px-4 py-3.5 text-white">
          <div>
            <div className="text-[14px] font-bold tracking-tight">BrightSmile Dental</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] opacity-90">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-white" /> Online
            </div>
          </div>
          <SparkIcon className="h-5 w-5 opacity-90" />
        </div>
        <div className="stagger space-y-2.5 bg-[var(--color-bg-soft)] px-4 py-5">
          <div className="animate-in max-w-[85%] rounded-2xl rounded-tl-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[13.5px] leading-relaxed">
            Hi! Do you take same-day emergency appointments?
          </div>
          <div className="animate-in ml-auto max-w-[85%] rounded-2xl rounded-tr-md bg-cta px-3.5 py-2.5 text-[13.5px] leading-relaxed text-white">
            We do — two emergency slots are kept open every day. Want me to book you in for
            today at 4:30?
          </div>
          <div className="animate-in max-w-[60%] rounded-2xl rounded-tl-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[13.5px]">
            Yes please!
          </div>
          <div className="animate-in ml-auto w-fit rounded-2xl rounded-tr-md bg-cta px-4 py-3 text-white">
            <TypingDots />
          </div>
        </div>
      </Card>

      {/* the other half of the product: a review-queue card peeking in */}
      <div className="animate-pop absolute -right-10 bottom-10 hidden w-[210px] lg:block">
        <Card className="p-3.5 shadow-xl">
          <Badge tone="warning">Needs review</Badge>
          <p className="mt-2 text-[12.5px] leading-snug text-[var(--color-muted)]">
            &ldquo;I&rsquo;m really unhappy with my last visit&hellip;&rdquo;
          </p>
          <div className="mt-2.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--color-success)]">
            <CheckIcon className="h-3.5 w-3.5" /> Approve &amp; send
          </div>
        </Card>
      </div>
    </div>
  );
}
