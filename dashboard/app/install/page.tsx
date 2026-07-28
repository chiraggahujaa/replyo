"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/api";
import { Shell } from "../components/Shell";
import { useReplyo } from "../providers";

export default function InstallPage() {
  return (
    <Shell>
      <Install />
    </Shell>
  );
}

function Install() {
  const { active } = useReplyo();
  const [copied, setCopied] = useState(false);

  const snippet = active
    ? `<script src="${API_BASE}/widget/widget.js"\n        data-api="${API_BASE}"\n        data-tenant="${active.public_key}"></script>`
    : "";

  // Load the real widget onto THIS page so the user can test their own assistant live.
  useEffect(() => {
    if (!active) return;
    const s = document.createElement("script");
    s.src = `${API_BASE}/widget/widget.js`;
    s.dataset.api = API_BASE;
    s.dataset.tenant = active.public_key;
    document.body.appendChild(s);
    return () => {
      s.remove();
      // Cleanly dispose the widget (closes its socket + timers, removes its host) so
      // navigating away and back re-injects a fresh instance that syncs the latest
      // transcript — including a reply just approved in the queue.
      const w = (window as unknown as { __replyoWidget?: { teardown?: () => void } }).__replyoWidget;
      w?.teardown?.();
    };
  }, [active?.public_key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active) {
    return <div className="p-8 text-[13px] text-[var(--color-faint)]">Create a persona to get its embed snippet.</div>;
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8 space-y-7">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">Install</h1>
        <p className="mt-1 text-[13px] text-[var(--color-faint)]">
          Add <span className="font-medium text-[var(--color-text)]">{active.name}</span> to any website with one tag.
        </p>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Embed snippet</span>
          <button
            onClick={() => {
              navigator.clipboard.writeText(snippet);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-[12px] font-medium hover:bg-[var(--color-bg-soft)]"
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <pre className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3.5 text-[12.5px] leading-relaxed font-mono text-[var(--color-text)]">
          {snippet}
        </pre>
      </div>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-faint)]">Public key</div>
        <div className="mt-1 font-mono text-[13px]">{active.public_key}</div>
        <p className="mt-1.5 text-[11.5px] text-[var(--color-faint)]">
          Safe to expose — it only lets a visitor chat as this persona; it grants no access to your account or queue.
        </p>
      </div>

      <div className="rounded-xl bg-[var(--color-accent-wash,rgba(99,102,241,.08))] border border-[var(--color-border)] px-4 py-3.5">
        <div className="text-[13px] font-semibold">Test it right here 👉</div>
        <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">
          The chat bubble in the bottom-right of this page is <span className="font-medium">{active.name}</span>, running
          against your own knowledge. Ask it something only your documents would know. Reply tokens stream live;
          escalated complaints land in your review queue.
        </p>
      </div>
    </div>
  );
}
