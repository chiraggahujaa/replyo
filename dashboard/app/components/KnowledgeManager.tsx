"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  KnowledgeSource,
  addWebsite,
  deleteKnowledge,
  listKnowledge,
  uploadDocument,
} from "@/lib/api";
import { Badge, Button, Skeleton, Spinner, TextInput } from "./ui";
import {
  BookIcon,
  DocIcon,
  GlobeIcon,
  PlusIcon,
  TrashIcon,
  UploadIcon,
} from "./icons";

const STATUS_TONE: Record<string, "success" | "accent" | "warning" | "danger"> = {
  ready: "success",
  ingesting: "accent",
  pending: "warning",
  error: "danger",
};

/** Upload docs + add website URLs for a persona, with live ingestion status. */
export function KnowledgeManager({ tenantId }: { tenantId: string }) {
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Drives the skeleton: flips true after the first fetch settles (success or failure).
  const [loaded, setLoaded] = useState(false);
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
      } finally {
        if (!cancelled) setLoaded(true);
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

  async function onAddWebsite(e: React.SubmitEvent<HTMLFormElement>) {
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
        {/* Upload — the input is sr-only (not display:none) so it stays keyboard
            focusable; focus-within paints the ring on the card. */}
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2.5 rounded-3xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-6 text-center transition-all duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--accent-wash)] focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--ring)]">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--accent-wash)] text-[var(--color-accent-ink)]">
            <UploadIcon className="h-6 w-6" />
          </span>
          {busy ? (
            <span className="flex items-center justify-center gap-2 text-[14.5px] font-semibold text-[var(--color-muted)]">
              <Spinner className="h-4 w-4" />
              Uploading…
            </span>
          ) : (
            <span className="text-[14.5px] font-semibold">Upload documents</span>
          )}
          <span className="text-[12.5px] text-[var(--color-faint)]">.txt / .md — prices, services, FAQs</span>
          <input ref={fileRef} type="file" accept=".txt,.md,text/plain,text/markdown" multiple onChange={onUpload} className="sr-only" />
        </label>

        {/* Website */}
        <form
          onSubmit={onAddWebsite}
          className="glass flex flex-col gap-2.5 rounded-3xl border border-[var(--color-border)] px-4 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
        >
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--accent-wash)] text-[var(--color-accent-ink)]">
              <GlobeIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0 text-left">
              <span className="block text-[14.5px] font-semibold">Add a website</span>
              <span className="block text-[12.5px] text-[var(--color-faint)]">We deep-crawl every page (same domain).</span>
            </div>
          </div>
          <div className="mt-auto flex items-center gap-2">
            <TextInput
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-site.com"
              className="min-w-0 flex-1 px-3.5 py-2 text-[13.5px]"
            />
            <Button size="sm" loading={busy} icon={<PlusIcon className="h-3.5 w-3.5" />} className="shrink-0">
              Add
            </Button>
          </div>
        </form>
      </div>

      {err && <p className="animate-in text-[13px] text-[var(--color-danger)]">{err}</p>}

      {/* Sources — only this section skeletons while the first fetch is in flight, so
          the upload/website controls above stay usable immediately. */}
      {!loaded ? (
        <div className="space-y-2" aria-busy>
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : sources.length === 0 ? (
        <div className="animate-in flex flex-col items-center gap-2.5 rounded-3xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center">
          <BookIcon className="h-6 w-6 text-[var(--color-faint)]" />
          <p className="text-[13.5px] text-[var(--color-muted)]">
            No knowledge yet. Upload a document or add your website.
          </p>
        </div>
      ) : (
        <div className="stagger space-y-2">
          {sources.map((s) => (
            <div
              key={s.id}
              className="animate-in flex items-center justify-between gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--color-bg-soft)] text-[var(--color-muted)]">
                  {s.kind === "website" ? <GlobeIcon className="h-5 w-5" /> : <DocIcon className="h-5 w-5" />}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-medium">{s.name || s.url}</span>
                    <Badge tone={STATUS_TONE[s.status] ?? "neutral"} className="shrink-0">
                      {s.status === "ingesting" && <Spinner className="h-3 w-3" />}
                      {s.status === "ingesting" && s.kind === "website"
                        ? `crawling… ${s.page_count} pages`
                        : s.status}
                    </Badge>
                  </div>
                  <div className="text-[12.5px] text-[var(--color-faint)]">
                    {s.kind === "website" ? "Website" : "Document"}
                    {s.status === "ready" && ` · ${s.chunk_count} chunks`}
                    {s.error && ` · ${s.error.slice(0, 60)}`}
                  </div>
                </div>
              </div>
              <button
                onClick={() => remove(s.id)}
                title={`Remove ${s.name || s.url || "source"}`}
                aria-label={`Remove ${s.name || s.url || "source"}`}
                className="shrink-0 rounded-full p-2 text-[var(--color-faint)] transition-colors hover:bg-[var(--danger-wash)] hover:text-[var(--color-danger)]"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
