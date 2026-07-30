"use client";

// Catalog — the structured view of what extraction pulled out of a persona's knowledge:
// services and products (with pricing), customer-handling guidelines, and notable
// business facts. Everything is editable inline; any human write flips a row's status
// to "edited" server-side, so the Auto/Edited badges always tell the owner what came
// from the machine and what they've already vetted. While an extraction runs we poll
// every 3s (extraction is a background job with no push channel of its own) and stop
// the moment it settles.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  type CatalogItem,
  type CatalogItemInput,
  type CatalogResponse,
  type CatalogSettings,
  type CatalogSnippet,
  createCatalogItem,
  createSnippet,
  deleteCatalogImage,
  deleteCatalogItem,
  deleteSnippet,
  getCatalog,
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

type ItemKind = "service" | "product";
type SnippetKind = "guideline" | "content";
/** The four tabs backed by catalog rows. "hours" is the fifth tab — a settings editor,
 *  not a list, so it has no add label, plural or count. */
type EntryKind = ItemKind | SnippetKind;
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

export default function CatalogPage() {
  return (
    <Shell>
      <CatalogForActive />
    </Shell>
  );
}

// Remount on persona switch so all state (data, tab, editors, timers) resets cleanly.
function CatalogForActive() {
  const { active } = useReplyo();
  if (!active) {
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

  const pushToast = useCallback((kind: ToastItem["kind"], text: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  // Apply a fresh snapshot and announce the running -> done/error transition. Lives on
  // the fetch path (not an effect watching `data`) so each transition toasts exactly
  // once, no matter how renders interleave.
  const applyData = useCallback(
    (d: CatalogResponse) => {
      const prev = statusRef.current;
      statusRef.current = d.extraction.status;
      setData(d);
      if (prev === "running" && d.extraction.status === "done") {
        const n = d.items.filter((i) => i.kind === "service").length;
        const m = d.items.filter((i) => i.kind === "product").length;
        pushToast(
          "success",
          `Extraction complete — ${n} service${n === 1 ? "" : "s"}, ${m} product${m === 1 ? "" : "s"} found`,
        );
      } else if (prev === "running" && d.extraction.status === "error") {
        pushToast("error", d.extraction.error || "Extraction failed");
      }
    },
    [pushToast],
  );

  // Initial load (re-runs per persona thanks to the key remount).
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

  // Poll every 3s only while an extraction runs; the cleanup covers unmount and
  // persona switch, and the effect retires itself when the status leaves "running".
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

  const selectTab = (key: string) => {
    setTab(key as TabKey);
    setEditingId(null);
    setAdding(false);
  };

  const closeEditor = () => {
    setEditingId(null);
    setAdding(false);
  };

  const handleItemSaved = (saved: CatalogItem, created: boolean) => {
    setData(
      (d) =>
        d && {
          ...d,
          items: sortItems(
            created ? [...d.items, saved] : d.items.map((i) => (i.id === saved.id ? saved : i)),
          ),
        },
    );
    closeEditor();
    pushToast("success", created ? `${saved.kind === "service" ? "Service" : "Product"} added` : "Saved");
  };

  const handleItemDeleted = (id: string) => {
    setData((d) => d && { ...d, items: d.items.filter((i) => i.id !== id) });
    closeEditor();
    pushToast("success", "Deleted");
  };

  // A photo upload/removal writes the row immediately (it needs the item id), so the
  // card behind the editor has to reflect it even if the user then cancels. Deliberately
  // NOT closeEditor()/sorting: the owner is still mid-edit, and an image can't change
  // where the row sorts.
  const handleItemPatched = (updated: CatalogItem) => {
    setData(
      (d) => d && { ...d, items: d.items.map((i) => (i.id === updated.id ? updated : i)) },
    );
  };

  const handleSettingsSaved = (settings: CatalogSettings) => {
    setData((d) => d && { ...d, settings });
  };

  const handleSnippetSaved = (saved: CatalogSnippet, created: boolean) => {
    setData(
      (d) =>
        d && {
          ...d,
          snippets: sortSnippets(
            created
              ? [...d.snippets, saved]
              : d.snippets.map((s) => (s.id === saved.id ? saved : s)),
          ),
        },
    );
    closeEditor();
    pushToast("success", created ? (saved.kind === "guideline" ? "Guideline added" : "Note added") : "Saved");
  };

  const handleSnippetDeleted = (id: string) => {
    setData((d) => d && { ...d, snippets: d.snippets.filter((s) => s.id !== id) });
    closeEditor();
    pushToast("success", "Deleted");
  };

  const items = data?.items ?? [];
  const snippets = data?.snippets ?? [];
  const counts: Record<EntryKind, number> = {
    service: items.filter((i) => i.kind === "service").length,
    product: items.filter((i) => i.kind === "product").length,
    guideline: snippets.filter((s) => s.kind === "guideline").length,
    content: snippets.filter((s) => s.kind === "content").length,
  };
  const tabs = [
    ...(Object.keys(TAB_META) as EntryKind[]).map((k) => ({
      key: k,
      label: TAB_META[k].label,
      count: data ? counts[k] : undefined,
    })),
    // No count: hours isn't a list, and "7" would read as seven of something.
    { key: "hours", label: "Hours & booking" },
  ];

  const extraction = data?.extraction;
  const everExtracted = !!extraction?.last_extracted_at;
  // Skeletons cover both the first page load and an in-flight extraction on an empty
  // tab — but never while an editor is open there, or starting an extraction would
  // unmount the editor and silently discard whatever the user has typed.
  const skeletonsFor = (count: number) =>
    loading || (count === 0 && running && !adding && editingId === null);

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

      <div className="mt-7">
        <Tabs tabs={tabs} value={tab} onChange={selectTab} />
      </div>

      <div className="mt-6">
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
        ) : tab === "service" || tab === "product" ? (
          <ItemsSection
            tenantId={tenantId}
            kind={tab}
            items={items.filter((i) => i.kind === tab)}
            showSkeletons={skeletonsFor(counts[tab])}
            everExtracted={everExtracted}
            // Absent while the first load is in flight: assume "off" so the photo picker
            // can't be clicked into a 503 before we know the server has storage at all.
            storageEnabled={data?.storage_enabled ?? false}
            editingId={editingId}
            adding={adding}
            extractBusy={extractBusy}
            onEdit={setEditingId}
            onStartAdd={() => {
              setEditingId(null);
              setAdding(true);
            }}
            onCloseEditor={closeEditor}
            onSaved={handleItemSaved}
            onDeleted={handleItemDeleted}
            onPatched={handleItemPatched}
            onToast={pushToast}
            onExtract={onExtract}
          />
        ) : (
          <SnippetsSection
            tenantId={tenantId}
            kind={tab}
            snippets={snippets.filter((s) => s.kind === tab)}
            showSkeletons={skeletonsFor(counts[tab])}
            everExtracted={everExtracted}
            editingId={editingId}
            adding={adding}
            extractBusy={extractBusy}
            onEdit={setEditingId}
            onStartAdd={() => {
              setEditingId(null);
              setAdding(true);
            }}
            onCloseEditor={closeEditor}
            onSaved={handleSnippetSaved}
            onDeleted={handleSnippetDeleted}
            onExtract={onExtract}
          />
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
  items,
  showSkeletons,
  everExtracted,
  storageEnabled,
  editingId,
  adding,
  extractBusy,
  onEdit,
  onStartAdd,
  onCloseEditor,
  onSaved,
  onDeleted,
  onPatched,
  onToast,
  onExtract,
}: {
  tenantId: string;
  kind: ItemKind;
  items: CatalogItem[];
  showSkeletons: boolean;
  everExtracted: boolean;
  storageEnabled: boolean;
  editingId: string | null;
  adding: boolean;
  extractBusy: boolean;
  onEdit: (id: string) => void;
  onStartAdd: () => void;
  onCloseEditor: () => void;
  onSaved: (item: CatalogItem, created: boolean) => void;
  onDeleted: (id: string) => void;
  onPatched: (item: CatalogItem) => void;
  onToast: (kind: ToastItem["kind"], text: string) => void;
  onExtract: () => void;
}) {
  if (showSkeletons) {
    return (
      <div className="grid gap-4 lg:grid-cols-2" aria-busy>
        {[0, 1, 2, 3].map((i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (items.length === 0 && !adding) {
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
      {items.map((item) =>
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
      {adding ? (
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
      ) : (
        <AddTile label={TAB_META[kind].add} onClick={onStartAdd} className="min-h-[140px]" />
      )}
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
  kind: ItemKind;
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
        onSaved(await createCatalogItem(tenantId, body), true);
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
          <PhotoField
            tenantId={tenantId}
            item={item}
            storageEnabled={storageEnabled}
            inputId={`${uid}-photo`}
            disabled={busy !== null}
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
function PhotoField({
  tenantId,
  item,
  storageEnabled,
  inputId,
  disabled,
  onPatched,
  onToast,
}: {
  tenantId: string;
  item?: CatalogItem;
  storageEnabled: boolean;
  inputId: string;
  /** True while the surrounding form is saving or deleting. */
  disabled: boolean;
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

  const photo = item?.image_url ?? null;
  // Two reasons the picker can't work, each worth saying out loud: there's no row to
  // attach a file to yet, or the server has no object storage — in which case every
  // upload answers 503, so it's kinder to say so than to let 5 MB go up and fail.
  const hint = !item
    ? "Save the product first, then add a photo"
    : !storageEnabled
      ? "Photo uploads aren’t configured on this server"
      : null;
  const locked = !item || !storageEnabled || disabled || busy !== null;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared first, so re-picking the same file after a rejection still fires onChange.
    e.target.value = "";
    if (!file || !item || busy) return;
    // Both limits mirror the backend, so a doomed upload never leaves the browser.
    if (!IMAGE_TYPES.includes(file.type)) {
      onToast("error", "Photos must be a PNG, JPEG or WebP image");
      return;
    }
    if (file.size > IMAGE_MAX_MB * 1024 * 1024) {
      onToast("error", `Photos must be under ${IMAGE_MAX_MB} MB`);
      return;
    }
    setBusy("upload");
    try {
      onPatched(await uploadCatalogImage(tenantId, item.id, file));
      onToast("success", photo ? "Photo replaced" : "Photo added");
    } catch (err) {
      onToast("error", errText(err, "Couldn’t upload the photo"));
    } finally {
      setBusy(null);
    }
  }

  async function onRemove() {
    if (!item || busy) return;
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

  const openPicker = () => fileRef.current?.click();
  return (
    <Field label="Photo" htmlFor={inputId} help={hint ?? undefined}>
      <div className="flex items-center gap-3">
        {/* The tile is the big target; the button beside it is the same action spelled
            out. Either opens the picker — same pairing as a card and its pencil. */}
        <button
          type="button"
          onClick={openPicker}
          disabled={locked}
          aria-label={photo ? "Replace photo" : "Add photo"}
          className={`relative grid h-[4.5rem] w-24 shrink-0 place-items-center overflow-hidden rounded-2xl transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-55 ${
            photo
              ? "border border-[var(--color-border)] bg-[var(--color-bg-soft)]"
              : "border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)]/50 text-[var(--color-faint)] hover:border-[var(--color-accent)] hover:bg-[var(--accent-wash)] hover:text-[var(--color-accent-ink)]"
          }`}
        >
          {photo ? (
            /* Same reason as ItemCard: the photo host is env-dependent at runtime, so
               next/image would need it pinned into next.config remotePatterns at build
               time. The button's aria-label names it, so the alt stays empty. */
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex flex-col items-center gap-1">
              <ImageIcon className="h-5 w-5" />
              <span className="text-[11px] font-semibold">Add photo</span>
            </span>
          )}
          {busy && (
            <span className="absolute inset-0 grid place-items-center bg-[var(--color-surface)]/75 text-[var(--color-muted)]">
              <Spinner className="h-4 w-4" />
            </span>
          )}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={openPicker}
            disabled={locked}
            loading={busy === "upload"}
            icon={<UploadIcon className="h-3.5 w-3.5" />}
          >
            {photo ? "Replace" : "Upload"}
          </Button>
          {photo && (
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={onRemove}
              disabled={disabled || busy === "upload"}
              loading={busy === "remove"}
              icon={<TrashIcon className="h-3.5 w-3.5" />}
            >
              {confirmRemove ? "Really remove?" : "Remove"}
            </Button>
          )}
        </div>
      </div>
      {/* sr-only rather than hidden so the "Photo" label above still opens the picker;
          the two visible controls are the real affordances, hence tabIndex -1. */}
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
  snippets,
  showSkeletons,
  everExtracted,
  editingId,
  adding,
  extractBusy,
  onEdit,
  onStartAdd,
  onCloseEditor,
  onSaved,
  onDeleted,
  onExtract,
}: {
  tenantId: string;
  kind: SnippetKind;
  snippets: CatalogSnippet[];
  showSkeletons: boolean;
  everExtracted: boolean;
  editingId: string | null;
  adding: boolean;
  extractBusy: boolean;
  onEdit: (id: string) => void;
  onStartAdd: () => void;
  onCloseEditor: () => void;
  onSaved: (snippet: CatalogSnippet, created: boolean) => void;
  onDeleted: (id: string) => void;
  onExtract: () => void;
}) {
  if (showSkeletons) {
    return (
      <div className="space-y-3" aria-busy>
        {[0, 1, 2].map((i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (snippets.length === 0 && !adding) {
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
      {snippets.map((snippet) =>
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
      {adding ? (
        <SnippetEditor
          key="new"
          tenantId={tenantId}
          kind={kind}
          onCancel={onCloseEditor}
          onSaved={onSaved}
          onDeleted={onDeleted}
        />
      ) : (
        <AddTile label={TAB_META[kind].add} onClick={onStartAdd} className="py-4" />
      )}
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
  kind: SnippetKind;
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

function AddTile({
  label,
  onClick,
  className = "",
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-center gap-2 rounded-3xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)]/50 px-4 py-6 text-[14px] font-semibold text-[var(--color-muted)] transition-all duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--accent-wash)] hover:text-[var(--color-accent-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${className}`}
    >
      <PlusIcon className="h-4 w-4" />
      {label}
    </button>
  );
}
