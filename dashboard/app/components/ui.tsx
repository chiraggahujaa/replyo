"use client";

// Replyo UI kit — every screen builds from these so the whole console feels like one
// product. Pills for actions, glass cards, shimmer skeletons, one spinner.

import Link from "next/link";
import { useEffect, useRef } from "react";
import { SparkIcon } from "./icons";

/* ---- Spinner --------------------------------------------------------------------- */

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`animate-spin ${className}`} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Chat-style “thinking” indicator. */
export function TypingDots({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} aria-label="Loading">
      <span className="typing-dot h-1.5 w-1.5 rounded-full bg-current" />
      <span className="typing-dot h-1.5 w-1.5 rounded-full bg-current" />
      <span className="typing-dot h-1.5 w-1.5 rounded-full bg-current" />
    </span>
  );
}

/* ---- Button ----------------------------------------------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "success" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-cta text-white glow-accent hover:brightness-110 hover:glow-accent-lg border border-transparent",
  secondary:
    "bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border-strong)] hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-2)]",
  ghost:
    "bg-transparent text-[var(--color-muted)] border border-transparent hover:bg-[var(--accent-wash)] hover:text-[var(--color-text)]",
  success:
    "bg-[var(--color-success)] text-[var(--on-success)] border border-transparent shadow-[0_8px_24px_-10px_var(--success)] hover:brightness-110",
  danger:
    "bg-transparent text-[var(--color-danger)] border border-[var(--color-border-strong)] hover:bg-[var(--danger-wash)] hover:border-[var(--color-danger)]",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "px-3.5 py-1.5 text-[13px] gap-1.5",
  md: "px-5 py-2.5 text-[14px] gap-2",
  lg: "px-6 py-3 text-[15px] gap-2",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  full = false,
  href,
  className = "",
  children,
  disabled,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
  full?: boolean;
  /** Renders a real <Link> with the same look — use for navigation so prefetch,
   *  middle-click and assistive tech keep working (never nest Button inside Link). */
  href?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = `inline-flex items-center justify-center rounded-full font-semibold tracking-tight
    transition-all duration-200 select-none active:scale-[0.96]
    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]
    disabled:opacity-55 disabled:pointer-events-none
    ${VARIANT[variant]} ${SIZE[size]} ${full ? "w-full" : ""} ${className}`;

  const content = (
    <>
      {loading ? <Spinner className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} /> : icon}
      {children}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className={cls}
        onClick={rest.onClick as unknown as React.MouseEventHandler<HTMLAnchorElement>}
      >
        {content}
      </Link>
    );
  }

  return (
    <button disabled={disabled || loading} aria-busy={loading || undefined} className={cls} {...rest}>
      {content}
    </button>
  );
}

/* ---- Surfaces --------------------------------------------------------------------- */

export function Card({
  className = "",
  hover = false,
  children,
}: {
  className?: string;
  hover?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`glass rounded-3xl border border-[var(--color-border)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${
        hover ? "card-hover" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

/* ---- Modal ------------------------------------------------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
      <button
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[2px]"
      />
      {/* OPAQUE surface, same reason as the persona switcher: `glass` is ~70% alpha and
          lets the page bleed through anything that overlays content. */}
      <div className="animate-pop relative w-full max-w-md rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-2xl">
        {title && (
          <h2 className="font-display text-[18px] font-semibold tracking-tight">{title}</h2>
        )}
        {children}
      </div>
    </div>
  );
}

/* ---- Loading placeholders ---------------------------------------------------------- */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`shimmer rounded-xl ${className}`} aria-hidden />;
}

/** Skeleton stand-in for a review-queue card. */
export function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]/60 p-4 space-y-2.5">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-3 w-10" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <div className="flex items-center justify-between pt-1">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-12" />
      </div>
    </div>
  );
}

/* ---- Badges ----------------------------------------------------------------------- */

type BadgeTone = "accent" | "success" | "warning" | "danger" | "neutral";

const TONE: Record<BadgeTone, string> = {
  accent: "bg-[var(--accent-wash)] text-[var(--color-accent-ink)]",
  success: "bg-[var(--success-wash)] text-[var(--color-success)]",
  warning: "bg-[var(--warning-wash)] text-[var(--color-warning)]",
  danger: "bg-[var(--danger-wash)] text-[var(--color-danger)]",
  neutral: "bg-[var(--color-bg-soft)] text-[var(--color-muted)]",
};

export function Badge({
  tone = "neutral",
  pulse = false,
  className = "",
  children,
}: {
  tone?: BadgeTone;
  pulse?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${TONE[tone]} ${className}`}
    >
      {pulse && <span className="live-dot h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/* ---- Tabs (segmented control) ------------------------------------------------------- */

/** Pill segmented control. Generic — keys/labels/counts in, selection out. One Tab stop
 *  for the whole group (roving tabindex + arrow keys), like native tabs. */
export function Tabs({
  tabs,
  value,
  onChange,
  className = "",
}: {
  tabs: { key: string; label: string; count?: number }[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const cur = Math.max(0, tabs.findIndex((t) => t.key === value));
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? tabs.length - 1
          : e.key === "ArrowLeft"
            ? (cur - 1 + tabs.length) % tabs.length
            : (cur + 1) % tabs.length;
    onChange(tabs[next].key);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      onKeyDown={onKeyDown}
      className={`glass inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-[var(--color-border)] p-1 ${className}`}
    >
      {tabs.map((t) => {
        const selected = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[13.5px] font-semibold tracking-tight transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
              selected
                ? "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-accent-ink)] shadow-sm"
                : "border border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {t.label}
            {typeof t.count === "number" && (
              <span
                className={`text-[11.5px] font-semibold tabular-nums ${
                  selected ? "text-[var(--color-muted)]" : "text-[var(--color-faint)]"
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ---- Form fields ------------------------------------------------------------------- */

const FIELD_BASE =
  "w-full rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder-[var(--color-faint)] outline-none transition-all duration-200 focus:border-[var(--color-accent)] focus:ring-4 focus:ring-[var(--ring)] focus:glow-accent";

export function TextInput({
  className = "",
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${FIELD_BASE} px-4 py-3 text-[14.5px] ${className}`} {...rest} />;
}

export function TextArea({
  className = "",
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`${FIELD_BASE} px-4 py-3 text-[14px] leading-relaxed ${className}`}
      {...rest}
    />
  );
}

/* ---- Page scaffolding --------------------------------------------------------------- */

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="animate-in flex items-start justify-between gap-4">
      <div>
        <h1 className="font-display text-[26px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1.5 text-[14px] text-[var(--color-muted)]">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0 pt-1">{action}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="animate-pop flex flex-col items-center justify-center gap-4 px-6 py-14 text-center">
      <div className="animate-float grid h-16 w-16 place-items-center rounded-[22px] bg-cta text-white glow-accent-lg">
        {icon}
      </div>
      <div>
        <p className="font-display text-[17px] font-semibold tracking-tight">{title}</p>
        {description && (
          <p className="mx-auto mt-1.5 max-w-sm text-[14px] text-[var(--color-muted)]">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/* ---- Splash (full-screen loading) --------------------------------------------------- */

export function Splash({ label = "Warming up your console" }: { label?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6">
      <div className="relative grid place-items-center">
        {/* orbiting halo */}
        <div className="splash-orbit absolute h-24 w-24 rounded-full border border-[var(--color-border)]">
          <span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-[var(--color-accent)] shadow-[0_0_12px_var(--glow)]" />
        </div>
        <div className="splash-mark grid h-14 w-14 place-items-center rounded-[20px] bg-cta text-white">
          <SparkIcon className="h-7 w-7" />
        </div>
      </div>
      <div className="flex flex-col items-center gap-3">
        <div className="font-display text-[15px] font-medium tracking-tight text-[var(--color-muted)]">
          {label}
        </div>
        <div className="h-1 w-36 overflow-hidden rounded-full bg-[var(--color-bg-soft)]">
          <div className="splash-bar h-full w-2/5 rounded-full bg-cta" />
        </div>
      </div>
    </div>
  );
}

/* ---- Toasts -------------------------------------------------------------------------- */

export type ToastItem = { id: number; kind: "success" | "error"; text: string };

export function ToastShelf({ toasts }: { toasts: ToastItem[] }) {
  // role=status lives on the always-mounted shelf, not the toasts: a live region must
  // exist before its content changes or screen readers won't announce insertions.
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`animate-toast pointer-events-auto flex items-center gap-2.5 rounded-full py-2.5 pl-4 pr-5 text-[14px] font-medium shadow-xl backdrop-blur ${
            t.kind === "success"
              ? "bg-[var(--color-success)] text-[var(--on-success)] shadow-[0_10px_30px_-8px_var(--success)]"
              : "bg-[var(--color-danger)] text-[var(--on-danger)] shadow-[0_10px_30px_-8px_var(--danger)]"
          }`}
        >
          <span className="grid h-5 w-5 place-items-center rounded-full bg-white/20 text-[11px]">
            {t.kind === "success" ? "✓" : "!"}
          </span>
          {t.text}
        </div>
      ))}
    </div>
  );
}
