"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  KnowledgeSource,
  addWebsite,
  deleteKnowledge,
  listKnowledge,
  uploadDocument,
} from "@/lib/api";

const STATUS_STYLE: Record<string, string> = {
  ready: "bg-emerald-500/10 text-emerald-600",
  ingesting: "bg-indigo-500/10 text-indigo-600",
  pending: "bg-amber-500/10 text-amber-600",
  error: "bg-rose-500/10 text-rose-600",
};

/** Upload docs + add website URLs for a persona, with live ingestion status. */
export function KnowledgeManager({ tenantId }: { tenantId: string }) {
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setSources(await listKnowledge(tenantId));
    } catch {
      /* transient */
    }
  }, [tenantId]);

  // Poll while anything is still ingesting so the crawl counter ticks up live. The load
  // is inlined (not a synchronous refresh() call) so setState only happens post-await.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await listKnowledge(tenantId);
        if (!cancelled) setSources(data);
      } catch {
        /* transient */
      }
    }
    load();
    const t = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [tenantId]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true);
    setErr(null);
    try {
      for (const f of files) await uploadDocument(tenantId, f);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onAddWebsite(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await addWebsite(tenantId, url.trim());
      setUrl("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't add website");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await deleteKnowledge(tenantId, id);
    await refresh();
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {/* Upload */}
        <label className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-6 text-center hover:border-[var(--color-accent)] transition">
          <span className="text-[13.5px] font-semibold">Upload documents</span>
          <span className="text-[11.5px] text-[var(--color-faint)]">.txt / .md — prices, services, FAQs</span>
          <input ref={fileRef} type="file" accept=".txt,.md,text/plain,text/markdown" multiple onChange={onUpload} className="hidden" />
        </label>

        {/* Website */}
        <form onSubmit={onAddWebsite} className="flex flex-col gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4">
          <span className="text-[13.5px] font-semibold">Add a website</span>
          <span className="text-[11.5px] text-[var(--color-faint)]">We deep-crawl every page (same domain).</span>
          <div className="mt-auto flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-site.com"
              className="min-w-0 flex-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px] outline-none focus:border-[var(--color-accent)]"
            />
            <button
              disabled={busy}
              className="rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              Add
            </button>
          </div>
        </form>
      </div>

      {err && <p className="text-[12.5px] text-rose-500">{err}</p>}

      {/* Sources */}
      <div className="space-y-1.5">
        {sources.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-[12.5px] text-[var(--color-faint)]">
            No knowledge yet. Upload a document or add your website.
          </p>
        ) : (
          sources.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium truncate">{s.name || s.url}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[s.status] || ""}`}>
                    {s.status === "ingesting" && s.kind === "website"
                      ? `crawling… ${s.page_count} pages`
                      : s.status}
                  </span>
                </div>
                <div className="text-[11px] text-[var(--color-faint)]">
                  {s.kind === "website" ? "Website" : "Document"}
                  {s.status === "ready" && ` · ${s.chunk_count} chunks`}
                  {s.error && ` · ${s.error.slice(0, 60)}`}
                </div>
              </div>
              <button onClick={() => remove(s.id)} className="text-[11px] text-[var(--color-faint)] hover:text-rose-500 shrink-0">
                Remove
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
