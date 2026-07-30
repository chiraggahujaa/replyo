"use client";

// Bits the catalog page and its Hours panel both need. They live here rather than in
// page.tsx so HoursPanel can use them without importing the page that renders it, and
// rather than in components/ui.tsx because they're catalog vocabulary, not kit.

import { Badge } from "../components/ui";

/** Surface a FastAPI error `detail` when the response carried one; otherwise fall back. */
export function errText(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) {
    const m = e.message.match(/"detail"\s*:\s*"([^"]+)"/);
    return m ? m[1] : fallback;
  }
  return fallback;
}

/** Auto vs Edited — the running answer to "did a machine write this, or did I?". */
export function StatusBadge({ status }: { status: "extracted" | "edited" }) {
  return status === "edited" ? (
    <Badge tone="success">Edited</Badge>
  ) : (
    <Badge tone="accent">Auto</Badge>
  );
}

export function Field({
  label,
  htmlFor,
  help,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]"
      >
        {label}
      </label>
      {children}
      {help && <p className="mt-1 text-[12px] text-[var(--color-faint)]">{help}</p>}
    </div>
  );
}
