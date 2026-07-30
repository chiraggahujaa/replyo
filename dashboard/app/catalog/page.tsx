"use client";

// Catalog — the structured view of what extraction pulled out of a persona's knowledge:
// services and products (with pricing), customer-handling guidelines, and notable
// business facts. Everything is editable inline; any human write flips a row's status
// to "edited" server-side, so the Auto/Edited badges always tell the owner what came
// from the machine and what they've already vetted. While an extraction runs we poll
// every 3s (extraction is a background job with no push channel of its own) and stop
// the moment it settles.
//
// Loading is deliberately lazy and paged, because a real persona has hundreds of rows:
// `getCatalog` fetches metadata only (counts, extraction state, settings) and each tab
// fetches its own rows PAGE_SIZE at a time, the first page on first visit and the rest
// as the reader scrolls. Switching to Services never downloads Products.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  type CatalogCounts,
  type CatalogItem,
  type CatalogItemInput,
  type CatalogItemKind,
  // Aliased: this module's default export is already called CatalogPage.
  type CatalogPage as EntriesPage,
  type CatalogResponse,
  type CatalogSettings,
  type CatalogSnippet,
  type CatalogSnippetKind,
  type EntryKind,
  createCatalogItem,
  createSnippet,
  deleteCatalogImage,
  deleteCatalogItem,
  deleteSnippet,
  getCatalog,
  listCatalogItems,
  listCatalogSnippets,
  timeAgo,
  triggerExtraction,
  updateCatalogItem,
  updateSnippet,
  uploadCatalogImage,
} from "@/lib/api";
import { CURRENCIES, DEFAULT_CURRENCY, formatPrice } from "@/lib/currency";
import { Shell } from "../components/Shell";
import { useReplyo } from "../providers";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Select,
  SkeletonCard,
  Spinner,
  Tabs,
  TextArea,
  TextInput,
  ToastShelf,
  type ToastItem,
} from "../components/ui";
import {
  AlertIcon,
  BookIcon,
  CheckIcon,
  ClockIcon,
  ImageIcon,
  LayersIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
  UploadIcon,
  WandIcon,
} from "../components/icons";
import { HoursPanel } from "./HoursPanel";
import { Field, StatusBadge, errText } from "./parts";

const POLL_MS = 3000;
// Two-click confirms (re-extract, delete, remove photo) fall back to the safe label
// after this.
const CONFIRM_MS = 3200;
/** Rows per request. Small enough that the first screen of a tab arrives immediately,
 *  large enough that a page always overflows the viewport and so the scroll sentinel
 *  starts out below the fold. */
const PAGE_SIZE = 15;

/** The four tabs backed by catalog rows (`EntryKind`, from lib/api — the same union the
 *  counts payload and the entries endpoint are keyed by). "hours" is the fifth tab — a
 *  settings editor, not a list, so it has no add label, plural or count. */
type TabKey = EntryKind | "hours";

const TAB_META: Record<EntryKind, { label: string; add: string; plural: string }> = {
  service: { label: "Services", add: "Add service", plural: "services" },
  product: { label: "Products", add: "Add product", plural: "products" },
  guideline: { label: "Guidelines", add: "Add guideline", plural: "guidelines" },
  content: { label: "Content", add: "Add note", plural: "notes" },
};

// Product photos: mirrors what the backend accepts, so a doomed upload never leaves the
// browser.
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const IMAGE_MAX_MB = 5;

/* Local inserts/edits keep the API's ordering (kind, category nulls last, lower(name) /
   kind, sort, lower(title)) so a saved card lands where a reload would put it. */

function cmpNullableText(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

const sortItems = (items: CatalogItem[]) =>
  [...items].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      cmpNullableText(a.category, b.category) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );

const sortSnippets = (snippets: CatalogSnippet[]) =>
  [...snippets].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.sort - b.sort ||
      a.title.toLowerCase().localeCompare(b.title.toLowerCase()),
  );

/** price_text verbatim (it's the owner's own wording), else the formatted amount, else
 *  null ("No price"). Everything that shows a price goes through here. */
function priceLabel(item: CatalogItem): string | null {
  if (item.price_text) return item.price_text;
  if (item.price_amount === null) return null;
  return formatPrice(item.price_amount, item.currency);
}

/* ---- Per-tab paged row cache -------------------------------------------------------- */

/** One tab's worth of rows. `cursor` is the opaque token for the NEXT page (null = the
 *  list is exhausted, so there is no sentinel and no wasted request); `loaded` says the
 *  first page has landed, which is what stops a re-visit from re-fetching. */
type PageCache<T> = {
  rows: T[];
  cursor: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
};

type ItemCaches = Record<CatalogItemKind, PageCache<CatalogItem>>;
type SnippetCaches = Record<CatalogSnippetKind, PageCache<CatalogSnippet>>;

const blankCache = <T,>(): PageCache<T> => ({
  rows: [],
  cursor: null,
  loading: false,
  loaded: false,
  error: null,
});

/** Invalidation keeps the rows already on screen and only clears the paging state, so a
 *  refetch (after an extraction settles) swaps the list when the fresh first page lands
 *  instead of blanking the tab — and an open editor keeps its row, and its typed text. */
const staleCache = <T,>(c: PageCache<T>): PageCache<T> => ({
  rows: c.rows,
  cursor: null,
  loading: false,
  loaded: false,
  error: null,
});

/** Fold a fetched page in. The first page (`requested === null`) replaces — that's the
 *  refetch-after-extraction path; later pages append, skipping ids already held so a row
 *  created locally, or an overlap at a page boundary, can never produce two cards with the
 *  same key. */
function applyPage<T extends { id: string }>(
  prev: PageCache<T>,
  page: EntriesPage<T>,
  requested: string | null,
): PageCache<T> {
  const first = requested === null;
  const seen = new Set(prev.rows.map((r) => r.id));
  const added = first ? page.entries : page.entries.filter((e) => !seen.has(e.id));
  // next_cursor === null is the contract's only terminator, but a cursor that didn't
  // advance, or a page that added nothing, would have the sentinel asking forever — so
  // treat those as the end too rather than letting a server bug become a request loop.
  const done =
    page.next_cursor === null || page.next_cursor === requested || (!first && added.length === 0);
  return {
    rows: first ? page.entries : [...prev.rows, ...added],
    cursor: done ? null : page.next_cursor,
    loading: false,
    loaded: true,
    error: null,
  };
}

/** What the tab panel's body is showing. Decided once in `Catalog` so the header's Add
 *  button and the section below it can never disagree about which state we're in. */
type PanelView = "skeletons" | "error" | "empty" | "list";

export default function CatalogPage() {
  return (
    <Shell>
      <CatalogForActive />
    </Shell>
  );
}

// Remount on persona switch so all state (data, tab, editors, timers) resets cleanly.
function CatalogForActive() {
  const { active, personasLoading } = useReplyo();
  if (!active) {
    // First-ever visit with a cold cache: the personas request is still out, so
    // "select a persona" would be premature — nothing exists to select yet.
    if (personasLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-24 text-[var(--color-faint)]">
        <Spinner className="h-5 w-5" />
        <span className="sr-only">Loading personas</span>
      </div>
    );
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center">
        <EmptyState
          icon={<LayersIcon className="h-7 w-7" />}
          title="Select or create a persona first"
          description="The catalog shows the services, products and guidance extracted for one persona — pick one to review it."
        />
      </div>
    );
  }
  return <Catalog key={active.id} tenantId={active.id} personaName={active.name} />;
}

function Catalog({ tenantId, personaName }: { tenantId: string; personaName: string }) {
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tab, setTab] = useState<TabKey>("service");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [extractBusy, setExtractBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const statusRef = useRef<CatalogResponse["extraction"]["status"] | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One cache per row shape rather than one keyed by EntryKind: a union of PageCache<Item>
  // and PageCache<Snippet> would need narrowing at every touch, and there is nothing to
  // narrow on. Two records, each already the right type.
  const [itemCache, setItemCache] = useState<ItemCaches>(() => ({
    service: blankCache(),
    product: blankCache(),
  }));
  const [snippetCache, setSnippetCache] = useState<SnippetCaches>(() => ({
    guideline: blankCache(),
    content: blankCache(),
  }));
  // The `(kind, cursor)` pairs currently in flight. This — not a boolean — is what makes a
  // double-fetch impossible: the observer can fire repeatedly for the same sentinel, and
  // every extra call finds its key already claimed and returns.
  const inflight = useRef<Set<string>>(new Set());
  // Bumped by every invalidation. A request that resolves against an older generation is
  // dropped, so rows fetched before an extraction settled can't append after it.
  const genRef = useRef(0);
  // The element observed to trigger the next page. Held in state (not a ref) so the
  // observer effect re-runs the moment it mounts, remounts or unmounts.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  // Whether the toolbar is pinned to the top of the scroll pane right now — drives its
  // chrome (glass/border/shadow only while overlaying content). See the guard element
  // rendered just above the toolbar.
  const [stuck, setStuck] = useState(false);
  const stuckGuardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const guard = stuckGuardRef.current;
    if (!guard) return;
    const io = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting));
    io.observe(guard);
    return () => io.disconnect();
  }, []);
  // The panel wrapper, NOT the sticky header inside it: a pinned sticky element already
  // reports itself as being at the top of the scrollport, so scrollIntoView on it does
  // nothing. Its non-sticky container is the thing that actually scrolls back into place.
  const panelRef = useRef<HTMLDivElement>(null);

  const pushToast = useCallback((kind: ToastItem["kind"], text: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  const updateItems = useCallback(
    (kind: CatalogItemKind, patch: (c: PageCache<CatalogItem>) => PageCache<CatalogItem>) =>
      setItemCache((c) => {
        const next = { ...c };
        next[kind] = patch(c[kind]);
        return next;
      }),
    [],
  );

  const updateSnippets = useCallback(
    (kind: CatalogSnippetKind, patch: (c: PageCache<CatalogSnippet>) => PageCache<CatalogSnippet>) =>
      setSnippetCache((c) => {
        const next = { ...c };
        next[kind] = patch(c[kind]);
        return next;
      }),
    [],
  );

  /** Drop every tab's paging state. The active tab's first-page effect picks it up on the
   *  next commit; the other three stay unfetched until someone visits them. */
  const invalidateEntries = useCallback(() => {
    genRef.current += 1;
    inflight.current.clear();
    setItemCache((c) => ({ service: staleCache(c.service), product: staleCache(c.product) }));
    setSnippetCache((c) => ({
      guideline: staleCache(c.guideline),
      content: staleCache(c.content),
    }));
  }, []);

  /** Fetch one page of `kind`. `cursor === null` asks for the first page. */
  const loadPage = useCallback(
    async (kind: EntryKind, cursor: string | null) => {
      const key = `${kind}|${cursor ?? ""}`;
      if (inflight.current.has(key)) return;
      inflight.current.add(key);
      const gen = genRef.current;
      const opts = { limit: PAGE_SIZE, cursor: cursor ?? undefined };
      try {
        if (kind === "service" || kind === "product") {
          updateItems(kind, (c) => ({ ...c, loading: true, error: null }));
          const page = await listCatalogItems(tenantId, kind, opts);
          if (genRef.current !== gen) return;
          updateItems(kind, (c) => applyPage(c, page, cursor));
        } else {
          updateSnippets(kind, (c) => ({ ...c, loading: true, error: null }));
          const page = await listCatalogSnippets(tenantId, kind, opts);
          if (genRef.current !== gen) return;
          updateSnippets(kind, (c) => applyPage(c, page, cursor));
        }
      } catch (e) {
        if (genRef.current !== gen) return;
        // Phrased as a description, because that's where it surfaces: under the error
        // card's own title. The retry-in-the-sentinel case shows a button, not this.
        const msg = errText(e, "Check your connection and try again.");
        if (kind === "service" || kind === "product")
          updateItems(kind, (c) => ({ ...c, loading: false, error: msg }));
        else updateSnippets(kind, (c) => ({ ...c, loading: false, error: msg }));
      } finally {
        inflight.current.delete(key);
      }
    },
    [tenantId, updateItems, updateSnippets],
  );

  // Apply a fresh metadata snapshot and announce the running -> done/error transition.
  // Lives on the fetch path (not an effect watching `data`) so each transition toasts
  // exactly once, no matter how renders interleave — and so the rows an extraction just
  // rewrote are invalidated exactly once too.
  const applyData = useCallback(
    (d: CatalogResponse) => {
      const prev = statusRef.current;
      statusRef.current = d.extraction.status;
      setData(d);
      if (prev !== "running") return;
      if (d.extraction.status === "done") {
        // Straight from the counts payload, which is the whole point of having one: the
        // loaded rows are a single page and would undercount.
        const n = d.counts.service;
        const m = d.counts.product;
        invalidateEntries();
        pushToast(
          "success",
          `Extraction complete — ${n} service${n === 1 ? "" : "s"}, ${m} product${m === 1 ? "" : "s"} found`,
        );
      } else if (d.extraction.status === "error") {
        invalidateEntries();
        pushToast("error", d.extraction.error || "Extraction failed");
      }
    },
    [pushToast, invalidateEntries],
  );

  // Initial metadata load (re-runs per persona thanks to the key remount). No rows here —
  // the active tab fetches its own first page below.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await getCatalog(tenantId);
        if (!cancelled) applyData(d);
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, applyData]);

  // The active list tab and its cache. `null` on the Hours tab, which is a settings editor
  // with no rows — so nothing below it ever fetches. Reading `.loading` / `.loaded` /
  // `.error` / `.cursor` off the union is fine; only `.rows` needs the narrowed branch.
  const active: EntryKind | null = tab === "hours" ? null : tab;
  const activeCache: PageCache<CatalogItem> | PageCache<CatalogSnippet> | null =
    active === null
      ? null
      : active === "service" || active === "product"
        ? itemCache[active]
        : snippetCache[active];

  // First page of the active tab, once. Re-runs on every cache change (the deps say so)
  // but the guards mean it only ever fires for a tab that has no page, none in flight and
  // no error to clear — which is also what stops an errored tab retrying in a loop.
  useEffect(() => {
    if (active === null || activeCache === null) return;
    if (activeCache.loaded || activeCache.loading || activeCache.error) return;
    // `loaded === false` always means cursor === null, i.e. ask for the first page. Kicked
    // off through an async wrapper, the same shape as the metadata load above — the fetch
    // owns its own loading flag, so it must not be a bare synchronous call from an effect.
    (async () => loadPage(active, null))();
  }, [active, activeCache, loadPage]);

  // Next page when the sentinel comes into view. Re-created whenever the sentinel node or
  // the cache changes, so a page landing immediately re-observes: on a fast scroll the
  // sentinel is still on screen, IntersectionObserver reports that on observe(), and the
  // next page starts at once. The bail-outs (no node, nothing more to fetch, request in
  // flight, unresolved error) mean the observer only exists when firing it is correct, and
  // the cleanup disconnects it on unmount, tab change and every re-run.
  useEffect(() => {
    if (!sentinel || active === null || activeCache === null) return;
    if (activeCache.cursor === null || activeCache.loading || activeCache.error) return;
    const cursor = activeCache.cursor;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadPage(active, cursor);
      },
      // Start the fetch a screenful early so rows are usually there before the reader is.
      { rootMargin: "300px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [sentinel, active, activeCache, loadPage]);

  // Poll every 3s only while an extraction runs — the cheap metadata endpoint only, never
  // the rows. The cleanup covers unmount and persona switch, and the effect retires itself
  // when the status leaves "running".
  const running = data?.extraction.status === "running";
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const t = setInterval(async () => {
      try {
        const d = await getCatalog(tenantId);
        if (!cancelled) applyData(d);
      } catch {
        /* transient — the next tick retries */
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [running, tenantId, applyData]);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const retry = async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      applyData(await getCatalog(tenantId));
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };

  // Re-request whichever page failed — the first one (cursor null), or the next one
  // mid-scroll. loadPage clears the error as it starts, which is also what un-parks the
  // first-page effect and the observer; nothing retries on its own.
  const retryEntries = () => {
    if (active === null || activeCache === null) return;
    void loadPage(active, activeCache.cursor);
  };

  // Re-extract replaces machine-extracted rows, so a second click confirms — except the
  // very first run, when there's nothing to replace yet.
  const onExtract = async () => {
    if (!data || extractBusy || running) return;
    const needsConfirm = !!data.extraction.last_extracted_at;
    if (needsConfirm && !confirming) {
      setConfirming(true);
      confirmTimer.current = setTimeout(() => setConfirming(false), CONFIRM_MS);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirming(false);
    setExtractBusy(true);
    try {
      await triggerExtraction(tenantId);
      // Flip to running locally so polling starts before the next fetch confirms it.
      statusRef.current = "running";
      setData((d) => d && { ...d, extraction: { ...d.extraction, status: "running", error: null } });
      // Every loaded page is about to be replaced server-side, so none of it can be
      // trusted as "already fetched" any more.
      invalidateEntries();
    } catch (e) {
      pushToast(
        "error",
        e instanceof Error && e.message.includes("Add knowledge first")
          ? "Add knowledge first"
          : errText(e, "Couldn't start extraction"),
      );
    } finally {
      setExtractBusy(false);
    }
  };

  /** Put the top of the tab panel back in view — but only when it actually isn't. The
   *  panel's scroll-mt matches the sticky toolbar's height, so "in view" means just below
   *  the toolbar, not underneath it (scrollIntoView alone landed every tab switch a
   *  toolbar-height too deep, which read as "already scrolled"). When the reader is at or
   *  above that line — e.g. sitting at the top of the page — switching tabs must not move
   *  the viewport at all. In an rAF so it measures the DOM the state change produced. */
  const scrollPanelToTop = (behavior: ScrollBehavior) =>
    requestAnimationFrame(() => {
      const el = panelRef.current;
      // 64 = the toolbar's height, the same value as the panel's scroll-mt-16.
      if (el && el.getBoundingClientRect().top < 64) {
        el.scrollIntoView({ behavior, block: "start" });
      }
    });

  const selectTab = (key: string) => {
    setTab(key as TabKey);
    setEditingId(null);
    setAdding(false);
    // Every tab starts at its own beginning. Without this, switching from 200 loaded
    // services to a 15-row tab would leave the scroll clamped near that short list's end —
    // right on the sentinel, which would then start fetching pages to catch up.
    scrollPanelToTop("auto");
  };

  const closeEditor = () => {
    setEditingId(null);
    setAdding(false);
  };

  /** Opening the blank editor puts it at the TOP of the list — the end of the list is pages
   *  away now — so the panel comes back into view with it. */
  const startAdd = () => {
    setEditingId(null);
    setAdding(true);
    scrollPanelToTop("smooth");
  };

  /** Keep the badge honest between metadata refreshes. Clamped at zero: a stale count and
   *  a local delete must never produce "-1 services". */
  const bumpCount = (kind: EntryKind, delta: number) =>
    setData(
      (d) =>
        d && { ...d, counts: { ...d.counts, [kind]: Math.max(0, d.counts[kind] + delta) } },
    );

  const handleItemSaved = (saved: CatalogItem, created: boolean) => {
    // Sorted insert, so a saved card lands where a reload would put it — within the pages
    // loaded so far, which is all this list claims to be.
    updateItems(saved.kind, (c) => ({
      ...c,
      rows: sortItems(created ? [...c.rows, saved] : c.rows.map((i) => (i.id === saved.id ? saved : i))),
    }));
    if (created) bumpCount(saved.kind, 1);
    closeEditor();
    pushToast("success", created ? `${saved.kind === "service" ? "Service" : "Product"} added` : "Saved");
  };

  const handleItemDeleted = (kind: CatalogItemKind, id: string) => {
    updateItems(kind, (c) => ({ ...c, rows: c.rows.filter((i) => i.id !== id) }));
    bumpCount(kind, -1);
    closeEditor();
    pushToast("success", "Deleted");
  };

  // A photo upload/removal writes the row immediately (it needs the item id), so the
  // card behind the editor has to reflect it even if the user then cancels. Deliberately
  // NOT closeEditor()/sorting: the owner is still mid-edit, and an image can't change
  // where the row sorts.
  const handleItemPatched = (updated: CatalogItem) => {
    updateItems(updated.kind, (c) => ({
      ...c,
      rows: c.rows.map((i) => (i.id === updated.id ? updated : i)),
    }));
  };

  const handleSettingsSaved = (settings: CatalogSettings) => {
    setData((d) => d && { ...d, settings });
  };

  const handleSnippetSaved = (saved: CatalogSnippet, created: boolean) => {
    updateSnippets(saved.kind, (c) => ({
      ...c,
      rows: sortSnippets(
        created ? [...c.rows, saved] : c.rows.map((s) => (s.id === saved.id ? saved : s)),
      ),
    }));
    if (created) bumpCount(saved.kind, 1);
    closeEditor();
    pushToast("success", created ? (saved.kind === "guideline" ? "Guideline added" : "Note added") : "Saved");
  };

  const handleSnippetDeleted = (kind: CatalogSnippetKind, id: string) => {
    updateSnippets(kind, (c) => ({ ...c, rows: c.rows.filter((s) => s.id !== id) }));
    bumpCount(kind, -1);
    closeEditor();
    pushToast("success", "Deleted");
  };

  // Straight from the server's counts payload — the loaded rows are one page and would
  // undercount. Absent until the first metadata response lands.
  const counts: CatalogCounts | null = data?.counts ?? null;
  const tabs = [
    ...(Object.keys(TAB_META) as EntryKind[]).map((k) => ({
      key: k,
      label: TAB_META[k].label,
      count: counts?.[k],
    })),
    // No count: hours isn't a list, and "7" would read as seven of something.
    { key: "hours", label: "Hours & booking" },
  ];

  const extraction = data?.extraction;
  const everExtracted = !!extraction?.last_extracted_at;

  const rowCount = activeCache?.rows.length ?? 0;
  // One decision for the whole panel. Anything already on screen (rows, or the blank
  // editor) wins — that's what keeps a refetch, or a starting extraction, from yanking an
  // open editor out from under someone. Otherwise: skeletons while the first page or an
  // extraction is working, the error card if that page failed, else the empty state.
  const view: PanelView =
    rowCount > 0 || adding
      ? "list"
      : loading || activeCache?.loading || (running && editingId === null)
        ? "skeletons"
        : activeCache?.error
          ? "error"
          : "empty";
  return (
    <div className="animate-in mx-auto w-full max-w-5xl px-6 py-8">
      <PageHeader
        title="Catalog"
        subtitle={
          <>
            Everything Replyo learned about{" "}
            <span className="font-medium text-[var(--color-text)]">{personaName}</span> — services,
            products, pricing and guidance. Review and edit anything.
          </>
        }
        action={
          <div className="flex items-center gap-2.5">
            {extraction?.status === "running" ? (
              <Badge tone="accent">
                <Spinner className="h-3 w-3" />
                Extracting…
              </Badge>
            ) : extraction?.status === "error" ? (
              <span title={extraction.error ?? "Extraction failed"}>
                <Badge tone="danger">Extraction failed</Badge>
              </span>
            ) : extraction?.last_extracted_at ? (
              <span
                className="hidden text-[12.5px] text-[var(--color-faint)] sm:block"
                title={new Date(extraction.last_extracted_at).toLocaleString()}
              >
                Last extracted {timeAgo(extraction.last_extracted_at)}
              </span>
            ) : null}
            <Button
              variant={confirming ? "danger" : "secondary"}
              size="sm"
              onClick={onExtract}
              disabled={!data || running}
              loading={extractBusy}
              icon={confirming ? undefined : <RefreshIcon className="h-3.5 w-3.5" />}
            >
              {confirming ? "Replace auto-extracted data?" : "Re-extract from knowledge"}
            </Button>
          </div>
        }
      />

      {/* One toolbar: the tabs and the tab's Add action on the same sticky row. Add used to
          sit in a band of its own below this, which was mostly empty space restating the
          count already on the tab badge. Sticky so both stay reachable however far down a
          paged list the reader is.

          The band chrome (glass + border + shadow) appears only while actually PINNED —
          at rest the row sits directly on the page like every other section, because a
          full-width bordered rectangle wrapping the pill bar read as exactly that: a
          rectangle. CSS can't observe "position: sticky is currently stuck", so a 1px
          guard right above it does: the guard scrolling out of the viewport IS the moment
          the row pins. Full-bleed (-mx-6/px-6 against the page's px-6) so the blur covers
          the rows passing underneath edge to edge. */}
      <div ref={stuckGuardRef} aria-hidden className="mt-7 h-px" />
      <div
        className={`sticky top-0 z-20 -mx-6 flex flex-wrap items-center justify-between gap-3 border-b px-6 py-3 transition-[border-color,box-shadow] duration-200 ${
          stuck
            ? "glass border-[var(--color-border)] shadow-[0_10px_28px_-18px_rgb(0_0_0/0.35)]"
            : "border-transparent"
        }`}
      >
        <Tabs tabs={tabs} value={tab} onChange={selectTab} />
        {/* Hidden for the bodies that own their own action (the empty and error states each
            have one button, and skeletons have nothing to add to yet), so there is never
            a second competing Add on screen. */}
        {active !== null && view === "list" && (
          <Button size="sm" onClick={startAdd} icon={<PlusIcon className="h-3.5 w-3.5" />}>
            {TAB_META[active].add}
          </Button>
        )}
      </div>

      <div ref={panelRef} className="mt-6 scroll-mt-16">
        {loadFailed ? (
          <Card className="animate-in">
            <EmptyState
              icon={<AlertIcon className="h-7 w-7" />}
              title="Couldn't load the catalog"
              description="Check your connection and try again."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={retry}
                  icon={<RefreshIcon className="h-3.5 w-3.5" />}
                >
                  Retry
                </Button>
              }
            />
          </Card>
        ) : tab === "hours" ? (
          loading ? (
            <div className="space-y-6" aria-busy>
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : (
            // Keyed on the last extraction: a run that finishes while this panel is open
            // has written new hours, so re-seed the form from them. Ordinary polls (and
            // our own saves, which reconcile in place) leave the key alone, so nothing
            // yanks the form out from under someone mid-edit.
            <HoursPanel
              key={extraction?.last_extracted_at ?? "never"}
              tenantId={tenantId}
              settings={data?.settings ?? null}
              onSaved={handleSettingsSaved}
              onToast={pushToast}
            />
          )
        ) : (
          <>
            {tab === "service" || tab === "product" ? (
              <ItemsSection
                tenantId={tenantId}
                kind={tab}
                cache={itemCache[tab]}
                total={counts?.[tab] ?? 0}
                view={view}
                everExtracted={everExtracted}
                // Absent while the first load is in flight: assume "off" so the photo picker
                // can't be clicked into a 503 before we know the server has storage at all.
                storageEnabled={data?.storage_enabled ?? false}
                editingId={editingId}
                adding={adding}
                extractBusy={extractBusy}
                sentinelRef={setSentinel}
                onEdit={setEditingId}
                onStartAdd={startAdd}
                onCloseEditor={closeEditor}
                onSaved={handleItemSaved}
                onDeleted={(id) => handleItemDeleted(tab, id)}
                onPatched={handleItemPatched}
                onToast={pushToast}
                onExtract={onExtract}
                onRetry={retryEntries}
              />
            ) : (
              <SnippetsSection
                tenantId={tenantId}
                kind={tab}
                cache={snippetCache[tab]}
                total={counts?.[tab] ?? 0}
                view={view}
                everExtracted={everExtracted}
                editingId={editingId}
                adding={adding}
                extractBusy={extractBusy}
                sentinelRef={setSentinel}
                onEdit={setEditingId}
                onStartAdd={startAdd}
                onCloseEditor={closeEditor}
                onSaved={handleSnippetSaved}
                onDeleted={(id) => handleSnippetDeleted(tab, id)}
                onExtract={onExtract}
                onRetry={retryEntries}
              />
            )}
          </>
        )}
      </div>

      <ToastShelf toasts={toasts} />
    </div>
  );
}

/* ---- Services / Products ------------------------------------------------------------ */

function ItemsSection({
  tenantId,
  kind,
  cache,
  total,
  view,
  everExtracted,
  storageEnabled,
  editingId,
  adding,
  extractBusy,
  sentinelRef,
  onEdit,
  onStartAdd,
  onCloseEditor,
  onSaved,
  onDeleted,
  onPatched,
  onToast,
  onExtract,
  onRetry,
}: {
  tenantId: string;
  kind: CatalogItemKind;
  cache: PageCache<CatalogItem>;
  /** This tab's server-side total, for the "Showing N of M" footnote. */
  total: number;
  view: PanelView;
  everExtracted: boolean;
  storageEnabled: boolean;
  editingId: string | null;
  adding: boolean;
  extractBusy: boolean;
  /** Attaches the scroll sentinel; the parent observes whatever node it receives. */
  sentinelRef: (node: HTMLDivElement | null) => void;
  onEdit: (id: string) => void;
  onStartAdd: () => void;
  onCloseEditor: () => void;
  onSaved: (item: CatalogItem, created: boolean) => void;
  onDeleted: (id: string) => void;
  onPatched: (item: CatalogItem) => void;
  onToast: (kind: ToastItem["kind"], text: string) => void;
  onExtract: () => void;
  onRetry: () => void;
}) {
  if (view === "skeletons") {
    return (
      <div className="grid gap-4 lg:grid-cols-2" aria-busy>
        {[0, 1, 2, 3].map((i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (view === "error") {
    return <EntriesError kind={kind} error={cache.error} onRetry={onRetry} />;
  }

  if (view === "empty") {
    return (
      <Card className="animate-in">
        {everExtracted ? (
          <EmptyState
            icon={<LayersIcon className="h-7 w-7" />}
            title="Nothing here yet"
            description={`No ${TAB_META[kind].plural} yet — add one, or re-extract from your knowledge.`}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={onStartAdd}
                icon={<PlusIcon className="h-3.5 w-3.5" />}
              >
                {TAB_META[kind].add}
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<WandIcon className="h-7 w-7" />}
            title="Nothing extracted yet"
            description="Add documents or a website in Knowledge, then extract — Replyo turns them into structured services, products, pricing and guidance."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2.5">
                <Button
                  variant="secondary"
                  size="sm"
                  href="/knowledge"
                  icon={<BookIcon className="h-3.5 w-3.5" />}
                >
                  Open Knowledge
                </Button>
                <Button
                  size="sm"
                  onClick={onExtract}
                  loading={extractBusy}
                  icon={<WandIcon className="h-3.5 w-3.5" />}
                >
                  Extract now
                </Button>
              </div>
            }
          />
        )}
      </Card>
    );
  }

  return (
    <div className="stagger grid items-start gap-4 lg:grid-cols-2">
      {/* The blank editor opens at the TOP: with pages of rows below, the bottom of the
          list isn't a place the reader can be assumed to be looking. */}
      {adding && (
        <ItemEditor
          key="new"
          tenantId={tenantId}
          kind={kind}
          storageEnabled={storageEnabled}
          onCancel={onCloseEditor}
          onSaved={onSaved}
          onDeleted={onDeleted}
          onPatched={onPatched}
          onToast={onToast}
        />
      )}
      {cache.rows.map((item) =>
        editingId === item.id ? (
          <ItemEditor
            key={item.id}
            tenantId={tenantId}
            kind={kind}
            item={item}
            storageEnabled={storageEnabled}
            onCancel={onCloseEditor}
            onSaved={onSaved}
            onDeleted={onDeleted}
            onPatched={onPatched}
            onToast={onToast}
          />
        ) : (
          <ItemCard key={item.id} item={item} onEdit={() => onEdit(item.id)} />
        ),
      )}
      <PageSentinel
        cache={cache}
        kind={kind}
        total={total}
        sentinelRef={sentinelRef}
        onRetry={onRetry}
        className="lg:col-span-2"
      />
    </div>
  );
}

function ItemCard({ item, onEdit }: { item: CatalogItem; onEdit: () => void }) {
  const price = priceLabel(item);
  const photo = item.kind === "product" ? item.image_url : null;
  return (
    <Card hover className="animate-in group overflow-hidden">
      {/* The whole card expands on click (pointer convenience); the pencil button is the
          real, keyboard-reachable affordance — hover-revealed on desktop, always visible
          on touch widths. */}
      <div className="cursor-pointer" onClick={onEdit}>
        {/* Products only, and only once there IS a photo — an empty frame on every other
            product would be noise, not a prompt. */}
        {photo && (
          <div className="aspect-[4/3] w-full overflow-hidden border-b border-[var(--color-border)] bg-[var(--color-bg-soft)]">
            {/* eslint-disable-next-line @next/next/no-img-element -- photos live on the
                API's object storage, whose host is env-dependent at runtime; next/image
                would need it pinned into next.config remotePatterns at build time. */}
            <img
              src={photo}
              alt={item.name}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </div>
        )}
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {item.category && (
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">
                  {item.category}
                </div>
              )}
              <h3 className="font-display text-[16px] font-semibold tracking-tight">{item.name}</h3>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <StatusBadge status={item.status} />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
                aria-label={`Edit ${item.name}`}
                className="rounded-full p-1.5 text-[var(--color-faint)] transition-all duration-200 hover:bg-[var(--accent-wash)] hover:text-[var(--color-accent-ink)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
              >
                <PencilIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          {item.description && (
            <p className="mt-2 line-clamp-2 text-[13.5px] leading-relaxed text-[var(--color-muted)]">
              {item.description}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* Chip text sits in a child span resetting the Badge's uppercase/tracking:
                price_text must render verbatim ("from ₹40,000" ≠ "FROM ₹40,000"), and a
                same-element normal-case would lose to the kit's uppercase in CSS order. */}
            {price ? (
              <Badge tone="accent">
                <span className="normal-case tracking-normal">{price}</span>
              </Badge>
            ) : (
              <span className="text-[12.5px] text-[var(--color-faint)]">No price</span>
            )}
            {item.kind === "service" && item.duration_min !== null && (
              <Badge tone="neutral">
                <ClockIcon className="h-3 w-3" />
                <span className="normal-case tracking-normal">{item.duration_min} min</span>
              </Badge>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function ItemEditor({
  tenantId,
  kind,
  item,
  storageEnabled,
  onCancel,
  onSaved,
  onDeleted,
  onPatched,
  onToast,
}: {
  tenantId: string;
  kind: CatalogItemKind;
  item?: CatalogItem;
  storageEnabled: boolean;
  onCancel: () => void;
  onSaved: (item: CatalogItem, created: boolean) => void;
  onDeleted: (id: string) => void;
  /** A photo write lands immediately, outside Save — this reconciles the row behind the
   *  editor without closing it or re-sorting the grid. */
  onPatched: (item: CatalogItem) => void;
  onToast: (kind: ToastItem["kind"], text: string) => void;
}) {
  const uid = useId();
  const [name, setName] = useState(item?.name ?? "");
  // One control per price column — currency, amount, display text — so nothing here is
  // derived from anything else. That's the fix for an old bug: a single free-text field
  // seeded from priceLabel() had to guess which column the owner meant, and a cleared
  // price resurrected through the fallback to the stale parsed amount. Now each field
  // maps 1:1 to its column and clearing one clears exactly that one (see onSubmit).
  // A code we don't offer (a pre-INR or hand-edited row) falls back to the default rather
  // than leaving the select showing nothing.
  const [currency, setCurrency] = useState(
    CURRENCIES.find((c) => c.code === item?.currency)?.code ?? DEFAULT_CURRENCY,
  );
  const [amount, setAmount] = useState(item?.price_amount != null ? String(item.price_amount) : "");
  const [priceText, setPriceText] = useState(item?.price_text ?? "");
  const [duration, setDuration] = useState(item?.duration_min != null ? String(item.duration_min) : "");
  const [category, setCategory] = useState(item?.category ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  // Add-mode only: a photo picked before the row exists. Save creates the product first,
  // then uploads this — the row id the image endpoint needs simply doesn't exist earlier.
  const [stagedPhoto, setStagedPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const delTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (delTimer.current) clearTimeout(delTimer.current);
    },
    [],
  );

  // Empty means "clear the duration"; anything else must be a whole number in the
  // backend's accepted range (1-600) — validated, not coerced, so a typed "0" errors
  // instead of silently saving as 1 minute.
  const parseDuration = (raw: string): number | null | "invalid" => {
    const t = raw.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isInteger(n) && n >= 1 && n <= 600 ? n : "invalid";
  };

  // Empty means "no numeric price"; anything else must be a non-negative finite number
  // (the backend's ge=0). Validated rather than coerced, so a typo is reported instead
  // of quietly saving as nothing.
  const parseAmount = (raw: string): number | null | "invalid" => {
    const t = raw.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : "invalid";
  };

  async function onSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    const dur = kind === "service" ? parseDuration(duration) : null;
    if (dur === "invalid") {
      setErr("Duration must be a whole number of minutes between 1 and 600.");
      return;
    }
    const amt = parseAmount(amount);
    if (amt === "invalid") {
      setErr("Amount must be a number — use Display price for ranges and wording.");
      return;
    }
    const text = priceText.trim() || null;
    setBusy("save");
    setErr(null);
    try {
      if (item) {
        // PATCH only what actually changed; an empty diff just closes the editor.
        const patch: Partial<Omit<CatalogItemInput, "kind">> = {};
        if (trimmed !== item.name) patch.name = trimmed;
        if (amt !== item.price_amount) patch.price_amount = amt;
        if (text !== item.price_text) patch.price_text = text;
        // Currency isn't edited on its own — it's implied by the amount. An amount pins
        // the selected code (CURRENCIES holds only INR today, the one code the backend
        // accepts); a row left with neither an amount nor display text has no price at
        // all, so its currency goes too rather than lingering as a bare "₹".
        const nextCurrency = amt !== null ? currency : text !== null ? item.currency : null;
        if (nextCurrency !== item.currency) patch.currency = nextCurrency;
        if (kind === "service" && dur !== item.duration_min) patch.duration_min = dur;
        const cat = category.trim() || null;
        if (cat !== item.category) patch.category = cat;
        const desc = description.trim() || null;
        if (desc !== item.description) patch.description = desc;
        if (Object.keys(patch).length === 0) {
          onCancel();
          return;
        }
        onSaved(await updateCatalogItem(tenantId, item.id, patch), false);
      } else {
        const body: CatalogItemInput = { kind, name: trimmed };
        if (amt !== null) {
          body.price_amount = amt;
          body.currency = currency;
        }
        if (text) body.price_text = text;
        if (kind === "service" && dur !== null) body.duration_min = dur;
        if (category.trim()) body.category = category.trim();
        if (description.trim()) body.description = description.trim();
        const created = await createCatalogItem(tenantId, body);
        // A staged photo uploads right after the row exists (its id is the upload path).
        // The two outcomes are reported separately: the product is real either way, so a
        // failed photo must not read as a failed product — the row lands in the list and
        // the toast says exactly which half went wrong.
        if (stagedPhoto) {
          try {
            onSaved(await uploadCatalogImage(tenantId, created.id, stagedPhoto), true);
          } catch (photoErr) {
            onSaved(created, true);
            onToast(
              "error",
              `The product was added, but its photo didn’t upload — ${errText(photoErr, "open it to retry")}`,
            );
          }
        } else {
          onSaved(created, true);
        }
      }
    } catch (e) {
      setErr(errText(e, "Couldn't save"));
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (!item || busy) return;
    if (!confirmDel) {
      setConfirmDel(true);
      delTimer.current = setTimeout(() => setConfirmDel(false), CONFIRM_MS);
      return;
    }
    if (delTimer.current) clearTimeout(delTimer.current);
    setBusy("delete");
    setErr(null);
    try {
      await deleteCatalogItem(tenantId, item.id);
      onDeleted(item.id);
    } catch (e) {
      setErr(errText(e, "Couldn't delete"));
      setBusy(null);
      setConfirmDel(false);
    }
  }

  const fieldCls = "px-3.5 py-2.5 text-[14px]";
  return (
    <Card className="animate-pop ring-2 ring-[var(--ring)]">
      <form
        onSubmit={onSubmit}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        className="space-y-4 p-5"
      >
        <Field label="Name" htmlFor={`${uid}-name`}>
          <TextInput
            id={`${uid}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === "service" ? "e.g. Teeth whitening" : "e.g. Whitening kit"}
            className={fieldCls}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {/* A real select even though CURRENCIES holds one code: adding a currency has to
              be a data change, not a UI change. */}
          <Field label="Currency" htmlFor={`${uid}-currency`}>
            <Select
              id={`${uid}-currency`}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className={`${fieldCls} pr-11`}
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount" htmlFor={`${uid}-amount`} help="Numbers only">
            <TextInput
              id={`${uid}-amount`}
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="350"
              className={fieldCls}
            />
          </Field>
        </div>
        <Field
          label="Display price (optional)"
          htmlFor={`${uid}-price-text`}
          help="Overrides the amount — use for ranges like “from ₹40,000”"
        >
          <TextInput
            id={`${uid}-price-text`}
            value={priceText}
            onChange={(e) => setPriceText(e.target.value)}
            placeholder="from ₹40,000"
            className={fieldCls}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {kind === "service" && (
            <Field label="Duration (min)" htmlFor={`${uid}-duration`}>
              <TextInput
                id={`${uid}-duration`}
                type="number"
                min={1}
                max={600}
                inputMode="numeric"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                placeholder="30"
                className={fieldCls}
              />
            </Field>
          )}
          <Field label="Category" htmlFor={`${uid}-category`}>
            <TextInput
              id={`${uid}-category`}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. Cosmetic"
              className={fieldCls}
            />
          </Field>
        </div>
        {kind === "product" && (
          <PhotoDrop
            tenantId={tenantId}
            item={item}
            storageEnabled={storageEnabled}
            inputId={`${uid}-photo`}
            disabled={busy !== null}
            stagedFile={stagedPhoto}
            onStage={setStagedPhoto}
            onPatched={onPatched}
            onToast={onToast}
          />
        )}
        <Field label="Description" htmlFor={`${uid}-desc`}>
          <TextArea
            id={`${uid}-desc`}
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What it is, who it's for, anything the assistant should mention…"
            className={`${fieldCls} resize-none`}
          />
        </Field>
        {err && <p className="animate-in text-[13px] text-[var(--color-danger)]">{err}</p>}
        <div className="flex flex-wrap items-center gap-2.5 pt-1">
          <Button
            type="submit"
            size="sm"
            loading={busy === "save"}
            disabled={busy !== null || !name.trim()}
            icon={<CheckIcon className="h-3.5 w-3.5" />}
          >
            {item ? "Save" : TAB_META[kind].add}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </Button>
          {item && (
            <Button
              type="button"
              variant="danger"
              size="sm"
              className="ml-auto"
              onClick={onDelete}
              loading={busy === "delete"}
              disabled={busy === "save"}
              icon={<TrashIcon className="h-3.5 w-3.5" />}
            >
              {confirmDel ? "Really delete?" : "Delete"}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

/** The product photo — the one control in the editor that writes outside Save, because
 *  uploading needs an item id to attach the file to. So it PATCHes the row the moment a
 *  file is chosen and hands the fresh row up (onPatched) rather than waiting for Save,
 *  and the add-new-product editor renders it disabled until the row exists. */
function PhotoDrop({
  tenantId,
  item,
  storageEnabled,
  inputId,
  disabled,
  stagedFile,
  onStage,
  onPatched,
  onToast,
}: {
  tenantId: string;
  item?: CatalogItem;
  storageEnabled: boolean;
  inputId: string;
  /** True while the surrounding form is saving or deleting. */
  disabled: boolean;
  /** Add-mode only: the photo waiting for the row to exist (uploads on Save). */
  stagedFile: File | null;
  onStage: (file: File | null) => void;
  onPatched: (item: CatalogItem) => void;
  onToast: (kind: ToastItem["kind"], text: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const removeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (removeTimer.current) clearTimeout(removeTimer.current);
    },
    [],
  );

  // A dropped file previews via an object URL, revoked when replaced or unmounted —
  // each staged file leaks a blob: URL otherwise.
  const previewUrl = useMemo(
    () => (stagedFile ? URL.createObjectURL(stagedFile) : null),
    [stagedFile],
  );
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const photo = previewUrl ?? item?.image_url ?? null;
  const staged = previewUrl !== null;
  // Storage being off is the one hard lock — every upload would answer 503, so it's
  // kinder to say so than to let 5 MB go up and fail. No row yet is NOT a lock any more:
  // the file stages here and uploads right after Save creates the row.
  const locked = !storageEnabled || disabled || busy !== null;

  /** One gate for picker and drop alike — both limits mirror the backend, so a doomed
   *  upload never leaves the browser. With a row, upload now; without one, stage. */
  async function accept(file: File) {
    if (busy) return;
    if (!IMAGE_TYPES.includes(file.type)) {
      onToast("error", "Photos must be a PNG, JPEG or WebP image");
      return;
    }
    if (file.size > IMAGE_MAX_MB * 1024 * 1024) {
      onToast("error", `Photos must be under ${IMAGE_MAX_MB} MB`);
      return;
    }
    if (!item) {
      onStage(file);
      return;
    }
    setBusy("upload");
    try {
      onPatched(await uploadCatalogImage(tenantId, item.id, file));
      onToast("success", item.image_url ? "Photo replaced" : "Photo added");
    } catch (err) {
      onToast("error", errText(err, "Couldn’t upload the photo"));
    } finally {
      setBusy(null);
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared first, so re-picking the same file after a rejection still fires onChange.
    e.target.value = "";
    if (file) void accept(file);
  }

  async function onRemove() {
    if (busy) return;
    if (staged) {
      onStage(null); // nothing uploaded yet — no confirm ceremony for a local file
      return;
    }
    if (!item) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      removeTimer.current = setTimeout(() => setConfirmRemove(false), CONFIRM_MS);
      return;
    }
    if (removeTimer.current) clearTimeout(removeTimer.current);
    setConfirmRemove(false);
    setBusy("remove");
    try {
      onPatched(await deleteCatalogImage(tenantId, item.id));
      onToast("success", "Photo removed");
    } catch (err) {
      onToast("error", errText(err, "Couldn’t remove the photo"));
    } finally {
      setBusy(null);
    }
  }

  // dragenter/leave fire for every child crossed, so a bare boolean flickers; the depth
  // counter nets them out and only depth 0 really means "left the zone".
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const dragProps = locked
    ? {}
    : {
        onDragEnter: (e: React.DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragOver(true);
        },
        // preventDefault here is what makes the browser allow a drop at all.
        onDragOver: (e: React.DragEvent<HTMLDivElement>) => e.preventDefault(),
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        },
        onDrop: (e: React.DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void accept(file);
        },
      };

  const openPicker = () => fileRef.current?.click();
  // The empty zone is itself the button; with a photo, the overlay's Replace/Remove are
  // the interactive elements instead (nesting them under a role="button" would be
  // invalid), and clicking the image is a pointer convenience for Replace.
  const zoneInteractive = !locked && !photo;
  return (
    <Field
      label="Photo"
      htmlFor={inputId}
      help={!storageEnabled ? "Photo uploads aren’t configured on this server" : undefined}
    >
      <div
        role={zoneInteractive ? "button" : undefined}
        tabIndex={zoneInteractive ? 0 : undefined}
        aria-label={zoneInteractive ? "Add photo — drag and drop, or browse" : undefined}
        onClick={!locked ? openPicker : undefined}
        onKeyDown={
          zoneInteractive
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openPicker();
                }
              }
            : undefined
        }
        {...dragProps}
        className={`group/drop relative h-40 w-full overflow-hidden rounded-2xl border transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
          dragOver
            ? "scale-[1.01] border-[var(--color-accent)] bg-[var(--accent-wash)] shadow-[0_0_0_4px_var(--accent-wash)]"
            : photo
              ? "border-[var(--color-border)] bg-[var(--color-bg-soft)]"
              : "border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)]/50 hover:border-[var(--color-accent)] hover:bg-[var(--accent-wash)]"
        } ${locked ? "pointer-events-none opacity-55" : "cursor-pointer"}`}
      >
        {photo ? (
          <>
            {/* Same reason as ItemCard: the photo host is env-dependent at runtime, so
                next/image would need it pinned into next.config remotePatterns at build
                time. The zone's controls name the actions, so the alt stays empty. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo}
              alt=""
              className={`h-full w-full object-cover transition-transform duration-300 ${
                dragOver ? "scale-105 blur-[2px]" : ""
              }`}
            />
            {staged && (
              <span className="absolute left-3 top-3">
                <Badge tone="accent">
                  <span className="normal-case tracking-normal">Uploads when you save</span>
                </Badge>
              </span>
            )}
            {dragOver ? (
              <span className="absolute inset-0 grid place-items-center bg-[var(--color-surface)]/60 text-[13.5px] font-semibold text-[var(--color-accent-ink)]">
                Drop to replace the photo
              </span>
            ) : (
              /* Hover/focus-revealed on desktop, always present on touch widths — the
                 same reveal contract as a card's pencil. */
              <span
                className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-2 bg-gradient-to-t from-[rgb(0_0_0/0.45)] to-transparent p-3 opacity-100 transition-opacity duration-200 sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/drop:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={openPicker}
                  disabled={locked}
                  icon={<UploadIcon className="h-3.5 w-3.5" />}
                >
                  Replace
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={onRemove}
                  disabled={disabled || busy === "upload"}
                  loading={busy === "remove"}
                  icon={<TrashIcon className="h-3.5 w-3.5" />}
                >
                  {staged ? "Remove" : confirmRemove ? "Really remove?" : "Remove"}
                </Button>
              </span>
            )}
          </>
        ) : (
          <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-[var(--color-faint)]">
            <span
              className={`grid h-11 w-11 place-items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] transition-transform duration-200 ${
                dragOver ? "scale-110 -rotate-3" : "group-hover/drop:scale-105"
              }`}
            >
              <ImageIcon className="h-5 w-5" />
            </span>
            <span className="mt-1 text-[13.5px] font-semibold text-[var(--color-muted)]">
              {dragOver ? "Drop to add the photo" : "Drag & drop a photo"}
            </span>
            <span className="text-[12px]">
              or click to browse · PNG, JPEG or WebP · up to {IMAGE_MAX_MB} MB
            </span>
          </span>
        )}
        {busy === "upload" && (
          <span className="absolute inset-0 grid place-items-center bg-[var(--color-surface)]/75 text-[var(--color-muted)]">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <Spinner className="h-4 w-4" /> Uploading…
            </span>
          </span>
        )}
      </div>
      {/* sr-only rather than hidden so the "Photo" label above still opens the picker;
          the zone is the real affordance, hence tabIndex -1. */}
      <input
        ref={fileRef}
        id={inputId}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        disabled={locked}
        tabIndex={-1}
        onChange={onPick}
        className="sr-only"
      />
    </Field>
  );
}

/* ---- Guidelines / Content ----------------------------------------------------------- */

function SnippetsSection({
  tenantId,
  kind,
  cache,
  total,
  view,
  everExtracted,
  editingId,
  adding,
  extractBusy,
  sentinelRef,
  onEdit,
  onStartAdd,
  onCloseEditor,
  onSaved,
  onDeleted,
  onExtract,
  onRetry,
}: {
  tenantId: string;
  kind: CatalogSnippetKind;
  cache: PageCache<CatalogSnippet>;
  /** This tab's server-side total, for the "Showing N of M" footnote. */
  total: number;
  view: PanelView;
  everExtracted: boolean;
  editingId: string | null;
  adding: boolean;
  extractBusy: boolean;
  /** Attaches the scroll sentinel; the parent observes whatever node it receives. */
  sentinelRef: (node: HTMLDivElement | null) => void;
  onEdit: (id: string) => void;
  onStartAdd: () => void;
  onCloseEditor: () => void;
  onSaved: (snippet: CatalogSnippet, created: boolean) => void;
  onDeleted: (id: string) => void;
  onExtract: () => void;
  onRetry: () => void;
}) {
  if (view === "skeletons") {
    return (
      <div className="space-y-3" aria-busy>
        {[0, 1, 2].map((i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (view === "error") {
    return <EntriesError kind={kind} error={cache.error} onRetry={onRetry} />;
  }

  if (view === "empty") {
    return (
      <Card className="animate-in">
        {everExtracted ? (
          <EmptyState
            icon={<BookIcon className="h-7 w-7" />}
            title="Nothing here yet"
            description={`No ${TAB_META[kind].plural} yet — add one, or re-extract from your knowledge.`}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={onStartAdd}
                icon={<PlusIcon className="h-3.5 w-3.5" />}
              >
                {TAB_META[kind].add}
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<WandIcon className="h-7 w-7" />}
            title="Nothing extracted yet"
            description="Add documents or a website in Knowledge, then extract — Replyo turns them into structured services, products, pricing and guidance."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2.5">
                <Button
                  variant="secondary"
                  size="sm"
                  href="/knowledge"
                  icon={<BookIcon className="h-3.5 w-3.5" />}
                >
                  Open Knowledge
                </Button>
                <Button
                  size="sm"
                  onClick={onExtract}
                  loading={extractBusy}
                  icon={<WandIcon className="h-3.5 w-3.5" />}
                >
                  Extract now
                </Button>
              </div>
            }
          />
        )}
      </Card>
    );
  }

  return (
    <div className="stagger space-y-3">
      {/* Top, not bottom — see ItemsSection. */}
      {adding && (
        <SnippetEditor
          key="new"
          tenantId={tenantId}
          kind={kind}
          onCancel={onCloseEditor}
          onSaved={onSaved}
          onDeleted={onDeleted}
        />
      )}
      {cache.rows.map((snippet) =>
        editingId === snippet.id ? (
          <SnippetEditor
            key={snippet.id}
            tenantId={tenantId}
            kind={kind}
            snippet={snippet}
            onCancel={onCloseEditor}
            onSaved={onSaved}
            onDeleted={onDeleted}
          />
        ) : (
          <SnippetCard key={snippet.id} snippet={snippet} onEdit={() => onEdit(snippet.id)} />
        ),
      )}
      <PageSentinel cache={cache} kind={kind} total={total} sentinelRef={sentinelRef} onRetry={onRetry} />
    </div>
  );
}

function SnippetCard({ snippet, onEdit }: { snippet: CatalogSnippet; onEdit: () => void }) {
  return (
    <Card hover className="animate-in group">
      <div className="cursor-pointer p-5" onClick={onEdit}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 font-display text-[15px] font-semibold tracking-tight">
            {snippet.title}
          </h3>
          <div className="flex shrink-0 items-center gap-1.5">
            <StatusBadge status={snippet.status} />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              aria-label={`Edit ${snippet.title}`}
              className="rounded-full p-1.5 text-[var(--color-faint)] transition-all duration-200 hover:bg-[var(--accent-wash)] hover:text-[var(--color-accent-ink)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
            >
              <PencilIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-[13.5px] leading-relaxed text-[var(--color-muted)]">
          {snippet.body}
        </p>
      </div>
    </Card>
  );
}

function SnippetEditor({
  tenantId,
  kind,
  snippet,
  onCancel,
  onSaved,
  onDeleted,
}: {
  tenantId: string;
  kind: CatalogSnippetKind;
  snippet?: CatalogSnippet;
  onCancel: () => void;
  onSaved: (snippet: CatalogSnippet, created: boolean) => void;
  onDeleted: (id: string) => void;
}) {
  const uid = useId();
  const [title, setTitle] = useState(snippet?.title ?? "");
  const [body, setBody] = useState(snippet?.body ?? "");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const delTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (delTimer.current) clearTimeout(delTimer.current);
    },
    [],
  );

  async function onSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const t = title.trim();
    const b = body.trim();
    if (!t || !b || busy) return;
    setBusy("save");
    setErr(null);
    try {
      if (snippet) {
        const patch: Partial<Pick<CatalogSnippet, "title" | "body">> = {};
        if (t !== snippet.title) patch.title = t;
        if (b !== snippet.body) patch.body = b;
        if (Object.keys(patch).length === 0) {
          onCancel();
          return;
        }
        onSaved(await updateSnippet(tenantId, snippet.id, patch), false);
      } else {
        onSaved(await createSnippet(tenantId, { kind, title: t, body: b }), true);
      }
    } catch (e) {
      setErr(errText(e, "Couldn't save"));
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (!snippet || busy) return;
    if (!confirmDel) {
      setConfirmDel(true);
      delTimer.current = setTimeout(() => setConfirmDel(false), CONFIRM_MS);
      return;
    }
    if (delTimer.current) clearTimeout(delTimer.current);
    setBusy("delete");
    setErr(null);
    try {
      await deleteSnippet(tenantId, snippet.id);
      onDeleted(snippet.id);
    } catch (e) {
      setErr(errText(e, "Couldn't delete"));
      setBusy(null);
      setConfirmDel(false);
    }
  }

  const guideline = kind === "guideline";
  const fieldCls = "px-3.5 py-2.5 text-[14px]";
  return (
    <Card className="animate-pop ring-2 ring-[var(--ring)]">
      <form
        onSubmit={onSubmit}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        className="space-y-4 p-5"
      >
        <Field label="Title" htmlFor={`${uid}-title`}>
          <TextInput
            id={`${uid}-title`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={guideline ? "e.g. Insurance questions" : "e.g. Parking"}
            className={fieldCls}
          />
        </Field>
        <Field label={guideline ? "Guideline" : "Note"} htmlFor={`${uid}-body`}>
          <TextArea
            id={`${uid}-body`}
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={
              guideline
                ? "e.g. Always confirm insurance coverage before quoting a price…"
                : "e.g. Free parking is available behind the clinic…"
            }
            className={`${fieldCls} resize-y`}
          />
        </Field>
        {err && <p className="animate-in text-[13px] text-[var(--color-danger)]">{err}</p>}
        <div className="flex flex-wrap items-center gap-2.5 pt-1">
          <Button
            type="submit"
            size="sm"
            loading={busy === "save"}
            disabled={busy !== null || !title.trim() || !body.trim()}
            icon={<CheckIcon className="h-3.5 w-3.5" />}
          >
            {snippet ? "Save" : TAB_META[kind].add}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </Button>
          {snippet && (
            <Button
              type="button"
              variant="danger"
              size="sm"
              className="ml-auto"
              onClick={onDelete}
              loading={busy === "delete"}
              disabled={busy === "save"}
              icon={<TrashIcon className="h-3.5 w-3.5" />}
            >
              {confirmDel ? "Really delete?" : "Delete"}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

/* ---- Shared bits -------------------------------------------------------------------- */
/* StatusBadge, Field and errText live in ./parts — HoursPanel needs them too, and it
   can't import the page that renders it. */

/** Tail of a paged list: the node the parent's IntersectionObserver watches, plus whatever
 *  the current paging state has to say. It renders only while there IS a next page, so
 *  reaching the end of the list says nothing at all — an "end of list" line would just be
 *  noise on a list the reader already knows they've finished. */
function PageSentinel({
  cache,
  kind,
  total,
  sentinelRef,
  onRetry,
  className = "",
}: {
  cache: PageCache<unknown>;
  kind: EntryKind;
  /** Server-side count for this tab, so the footnote can say how far in the reader is. */
  total: number;
  sentinelRef: (node: HTMLDivElement | null) => void;
  onRetry: () => void;
  className?: string;
}) {
  // Nothing more to fetch -> no sentinel at all, and no "end of list" message: once every
  // row is on screen the tab badge's count is the whole truth, so a footnote saying the
  // same thing twice is noise. The progress line only exists while the two numbers differ.
  if (cache.cursor === null) return null;
  const shown = cache.rows.length;
  const progress = total > shown ? `Showing ${shown} of ${total}` : null;
  return (
    <div
      ref={sentinelRef}
      className={`flex min-h-[3.5rem] items-center justify-center py-2 ${className}`}
      aria-busy={cache.loading || undefined}
    >
      {cache.error ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          icon={<RefreshIcon className="h-3.5 w-3.5" />}
        >
          Couldn’t load more — retry
        </Button>
      ) : (
        <span className="flex items-center gap-2 text-[12.5px] tabular-nums text-[var(--color-faint)]">
          {cache.loading && <Spinner className="h-4 w-4" />}
          {cache.loading && <span className="sr-only">Loading more {TAB_META[kind].plural}</span>}
          {progress}
        </span>
      )}
    </div>
  );
}

/** The first page of a tab failed. Distinct from the whole-catalog failure above: the
 *  metadata (and so the tabs, counts and extraction state) loaded fine — only these rows
 *  didn't, so only these rows are worth retrying. */
function EntriesError({
  kind,
  error,
  onRetry,
}: {
  kind: EntryKind;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <Card className="animate-in">
      <EmptyState
        icon={<AlertIcon className="h-7 w-7" />}
        title={`Couldn’t load these ${TAB_META[kind].plural}`}
        description={error ?? "Check your connection and try again."}
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetry}
            icon={<RefreshIcon className="h-3.5 w-3.5" />}
          >
            Retry
          </Button>
        }
      />
    </Card>
  );
}
