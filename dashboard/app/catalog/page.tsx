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
  type CatalogSnippet,
  createCatalogItem,
  createSnippet,
  deleteCatalogItem,
  deleteSnippet,
  getCatalog,
  timeAgo,
  triggerExtraction,
  updateCatalogItem,
  updateSnippet,
} from "@/lib/api";
import { Shell } from "../components/Shell";
import { useReplyo } from "../providers";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
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
  LayersIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
  WandIcon,
} from "../components/icons";

const POLL_MS = 3000;
// Two-click confirms (re-extract, delete) fall back to the safe label after this.
const CONFIRM_MS = 3200;

type TabKey = "service" | "product" | "guideline" | "content";
type ItemKind = "service" | "product";
type SnippetKind = "guideline" | "content";

const TAB_META: Record<TabKey, { label: string; add: string; plural: string }> = {
  service: { label: "Services", add: "Add service", plural: "services" },
  product: { label: "Products", add: "Add product", plural: "products" },
  guideline: { label: "Guidelines", add: "Add guideline", plural: "guidelines" },
  content: { label: "Content", add: "Add note", plural: "notes" },
};

/** Surface a FastAPI error `detail` when the response carried one; otherwise fall back. */
function errText(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) {
    const m = e.message.match(/"detail"\s*:\s*"([^"]+)"/);
    return m ? m[1] : fallback;
  }
  return fallback;
}

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

/** price_text verbatim, else formatted amount + currency, else null ("No price"). */
function priceLabel(item: CatalogItem): string | null {
  if (item.price_text) return item.price_text;
  if (item.price_amount === null) return null;
  const amount = item.price_amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return item.currency ? `${item.currency} ${amount}` : amount;
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
  const counts: Record<TabKey, number> = {
    service: items.filter((i) => i.kind === "service").length,
    product: items.filter((i) => i.kind === "product").length,
    guideline: snippets.filter((s) => s.kind === "guideline").length,
    content: snippets.filter((s) => s.kind === "content").length,
  };
  const tabs = (Object.keys(TAB_META) as TabKey[]).map((k) => ({
    key: k,
    label: TAB_META[k].label,
    count: data ? counts[k] : undefined,
  }));

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
        ) : tab === "service" || tab === "product" ? (
          <ItemsSection
            tenantId={tenantId}
            kind={tab}
            items={items.filter((i) => i.kind === tab)}
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
            onSaved={handleItemSaved}
            onDeleted={handleItemDeleted}
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
  kind: ItemKind;
  items: CatalogItem[];
  showSkeletons: boolean;
  everExtracted: boolean;
  editingId: string | null;
  adding: boolean;
  extractBusy: boolean;
  onEdit: (id: string) => void;
  onStartAdd: () => void;
  onCloseEditor: () => void;
  onSaved: (item: CatalogItem, created: boolean) => void;
  onDeleted: (id: string) => void;
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
            onCancel={onCloseEditor}
            onSaved={onSaved}
            onDeleted={onDeleted}
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
          onCancel={onCloseEditor}
          onSaved={onSaved}
          onDeleted={onDeleted}
        />
      ) : (
        <AddTile label={TAB_META[kind].add} onClick={onStartAdd} className="min-h-[140px]" />
      )}
    </div>
  );
}

function ItemCard({ item, onEdit }: { item: CatalogItem; onEdit: () => void }) {
  const price = priceLabel(item);
  return (
    <Card hover className="animate-in group">
      {/* The whole card expands on click (pointer convenience); the pencil button is the
          real, keyboard-reachable affordance — hover-revealed on desktop, always visible
          on touch widths. */}
      <div className="cursor-pointer p-5" onClick={onEdit}>
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
              price_text must render verbatim ("From AED 200" ≠ "FROM AED 200"), and a
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
    </Card>
  );
}

function ItemEditor({
  tenantId,
  kind,
  item,
  onCancel,
  onSaved,
  onDeleted,
}: {
  tenantId: string;
  kind: ItemKind;
  item?: CatalogItem;
  onCancel: () => void;
  onSaved: (item: CatalogItem, created: boolean) => void;
  onDeleted: (id: string) => void;
}) {
  const uid = useId();
  const [name, setName] = useState(item?.name ?? "");
  // One price field for the three price columns: seed from price_text, else the
  // formatted price_amount fallback — exactly what the card shows, so a numeric-only
  // price is visible and editable here. Any change clears price_amount/currency in
  // the PATCH (see onSubmit); otherwise a cleared or corrected price would silently
  // resurrect through priceLabel()'s fallback to the stale parsed amount.
  const initialPrice = item ? (priceLabel(item) ?? "") : "";
  const [price, setPrice] = useState(initialPrice);
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

  async function onSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    const dur = kind === "service" ? parseDuration(duration) : null;
    if (dur === "invalid") {
      setErr("Duration must be a whole number of minutes between 1 and 600.");
      return;
    }
    setBusy("save");
    setErr(null);
    try {
      if (item) {
        // PATCH only what actually changed; an empty diff just closes the editor.
        const patch: Partial<Omit<CatalogItemInput, "kind">> = {};
        if (trimmed !== item.name) patch.name = trimmed;
        if (price.trim() !== initialPrice.trim()) {
          // The owner rewrote (or cleared) the price: what they typed is now the
          // whole truth, so drop the machine-parsed amount/currency alongside.
          patch.price_text = price.trim() || null;
          patch.price_amount = null;
          patch.currency = null;
        }
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
        if (price.trim()) body.price_text = price.trim();
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
        <div className={`grid gap-4 ${kind === "service" ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          <Field
            label="Price"
            htmlFor={`${uid}-price`}
            help="Shown exactly as written, e.g. AED 200-350"
          >
            <TextInput
              id={`${uid}-price`}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="AED 350"
              className={fieldCls}
            />
          </Field>
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

function StatusBadge({ status }: { status: "extracted" | "edited" }) {
  return status === "edited" ? (
    <Badge tone="success">Edited</Badge>
  ) : (
    <Badge tone="accent">Auto</Badge>
  );
}

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

function Field({
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
