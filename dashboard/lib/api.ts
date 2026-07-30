// Thin client for the Replyo FastAPI backend.
//
// Every call carries the Supabase access token (Authorization: Bearer) and, for
// persona-scoped routes, the active persona id (X-Tenant-Id). The backend verifies the
// token and enforces membership, so the header is a request, not a trust boundary.

import { supabase } from "./supabase";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "http://localhost:8000";

async function authHeaders(tenantId?: string): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (data.session?.access_token) h["Authorization"] = `Bearer ${data.session.access_token}`;
  if (tenantId) h["X-Tenant-Id"] = tenantId;
  return h;
}

async function req<T>(path: string, opts: RequestInit & { tenantId?: string } = {}): Promise<T> {
  const { tenantId, ...init } = opts;
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(await authHeaders(tenantId)), ...(init.headers || {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${init.method || "GET"} ${path} -> ${res.status} ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ---- types ----

export type Persona = {
  id: string;
  name: string;
  slug: string | null;
  public_key: string;
  system_prompt: string | null;
  extra_notes: string | null;
  timezone: string;
  onboarding_status: string;
  // Lifecycle: "active" | "paused". Paused personas keep their console but the public
  // widget stops answering. Optional so the dashboard keeps working against a backend
  // that predates the status migration (absent -> active).
  status?: "active" | "paused";
  // Widget appearance saved from the Install page (name + styling). Optional so the
  // dashboard keeps working against a backend that predates the widget_config migration.
  widget_config?: Record<string, unknown> | null;
  created_at: string;
};

export type KnowledgeSource = {
  id: string;
  tenant_id: string;
  kind: "upload" | "website";
  name: string | null;
  url: string | null;
  status: "pending" | "ingesting" | "ready" | "error";
  page_count: number;
  chunk_count: number;
  error: string | null;
  created_at: string;
};

export type Turn = { role: "human" | "ai"; content: string };

export type Review = {
  id: string;
  thread_id: string;
  channel: string;
  chat_id: string | null;
  reason: string | null;
  draft: string | null;
  conversation: Turn[];
  status: string;
  created_at: string;
};

export type DecisionAction = "approve" | "edit" | "reject";

// ---- personas ----

export const listPersonas = () => req<Persona[]>("/api/personas");
export const createPersona = (name: string, timezone = "UTC") =>
  req<Persona>("/api/personas", { method: "POST", body: JSON.stringify({ name, timezone }) });
export const getActivePersona = (tenantId: string) =>
  req<Persona>("/api/personas/active", { tenantId });
export const updatePersona = (tenantId: string, patch: Partial<Persona>) =>
  req<Persona>("/api/personas/active", { method: "PATCH", tenantId, body: JSON.stringify(patch) });
// Owner-only (403 for plain members). Cascades wipe the persona's knowledge, reviews
// and follow-ups; its embed key stops resolving.
export const deletePersona = (tenantId: string) =>
  req<void>("/api/personas/active", { method: "DELETE", tenantId });
export const generatePrompt = (tenantId: string, name: string, notes: string) =>
  req<{ system_prompt: string }>("/api/personas/active/generate-prompt", {
    method: "POST",
    tenantId,
    body: JSON.stringify({ name, notes }),
  });

// ---- knowledge ----

export const listKnowledge = (tenantId: string) =>
  req<KnowledgeSource[]>("/api/personas/active/knowledge", { tenantId });
export const addWebsite = (tenantId: string, url: string, extra_urls: string[] = []) =>
  req<KnowledgeSource>("/api/personas/active/knowledge/website", {
    method: "POST",
    tenantId,
    body: JSON.stringify({ url, extra_urls }),
  });
export const deleteKnowledge = (tenantId: string, sourceId: string) =>
  req<void>(`/api/personas/active/knowledge/${sourceId}`, { method: "DELETE", tenantId });

export async function uploadDocument(tenantId: string, file: File): Promise<KnowledgeSource> {
  const { data } = await supabase.auth.getSession();
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/personas/active/knowledge/upload`, {
    method: "POST",
    headers: {
      "X-Tenant-Id": tenantId,
      ...(data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}),
    },
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

// ---- catalog ----

/** The two row shapes the catalog stores, split by which table they live in. `EntryKind`
 *  is the union both the counts payload and the paged entries endpoint are keyed by — the
 *  single definition of "one of the four list tabs". */
export type CatalogItemKind = "service" | "product";
export type CatalogSnippetKind = "guideline" | "content";
export type EntryKind = CatalogItemKind | CatalogSnippetKind;

/** Row totals per kind, straight from the server. The console's tab badges read these
 *  rather than counting loaded rows, because only one page of one tab is ever loaded. */
export type CatalogCounts = Record<EntryKind, number>;

export type CatalogItem = {
  id: string;
  kind: CatalogItemKind;
  name: string;
  description: string | null;
  price_text: string | null;
  price_amount: number | null;
  currency: string | null;
  duration_min: number | null;
  category: string | null;
  image_url: string | null;
  sort: number;
  source: string | null;
  status: "extracted" | "edited";
  created_at: string;
  updated_at: string;
};

export type CatalogSnippet = {
  id: string;
  kind: CatalogSnippetKind;
  title: string;
  body: string;
  source: string | null;
  sort: number;
  status: "extracted" | "edited";
  created_at: string;
  updated_at: string;
};

/** Opening hours keyed "0" (Monday) … "6" (Sunday). A null (or absent) day is closed. */
export type BusinessHours = Record<string, { open: string; close: string } | null>;

/** Opening hours + the appointment grid the assistant offers slots from. Extracted from
 *  knowledge, then editable; each half tracks its own extracted/edited status.
 *
 *  Only `hours` is nullable: a persona with no business_profiles row yet still reports the
 *  column defaults (30 / 0 / "extracted"), so the console renders one state, not two. */
export type CatalogSettings = {
  hours: BusinessHours | null;
  slot_minutes: number;
  buffer_minutes: number;
  hours_status: "extracted" | "edited";
  settings_status: "extracted" | "edited";
};

/** PATCH sends any subset; whatever is sent flips that half's status to "edited" — so the
 *  two sections must save separately, or fixing Tuesday would also claim the slot grid. */
export type CatalogSettingsInput = {
  hours?: BusinessHours | null;
  slot_minutes?: number;
  buffer_minutes?: number;
};

/** Catalog metadata — deliberately row-free. Rows come a page at a time from
 *  `listCatalogItems` / `listCatalogSnippets`, so this stays cheap enough to poll every
 *  few seconds while an extraction runs. */
export type CatalogResponse = {
  counts: CatalogCounts;
  extraction: {
    status: "idle" | "running" | "done" | "error";
    error: string | null;
    last_extracted_at: string | null;
  };
  settings: CatalogSettings;
  /** Whether the server has object storage configured at all. False means the image
   *  endpoints answer 503, so the console disables the picker up front rather than
   *  letting a 5 MB upload fail. */
  storage_enabled: boolean;
};

/** Writable item fields; PATCH sends any subset, POST requires kind + name. */
export type CatalogItemInput = {
  kind: CatalogItemKind;
  name: string;
  description?: string | null;
  price_text?: string | null;
  price_amount?: number | null;
  currency?: string | null;
  duration_min?: number | null;
  category?: string | null;
};

export type CatalogSnippetInput = {
  kind: CatalogSnippetKind;
  title: string;
  body: string;
};

/** One page of rows. `next_cursor === null` means the list is exhausted, so a caller never
 *  has to spend a request discovering there's nothing left. */
export type CatalogPage<T> = { entries: T[]; next_cursor: string | null };

export type CatalogPageOpts = { limit?: number; cursor?: string };

/** `cursor` is opaque — it goes back to the server verbatim, never parsed. */
function entriesPath(kind: EntryKind, opts?: CatalogPageOpts): string {
  const q = new URLSearchParams({ kind });
  if (opts?.limit !== undefined) q.set("limit", String(opts.limit));
  if (opts?.cursor) q.set("cursor", opts.cursor);
  return `/api/personas/active/catalog/entries?${q.toString()}`;
}

export const getCatalog = (tenantId: string) =>
  req<CatalogResponse>("/api/personas/active/catalog", { tenantId });

/* Two typed views of the one /entries endpoint. Splitting them by row shape is what keeps
   every call site free of casts: the kind you ask for decides the type you get back. */

export const listCatalogItems = (
  tenantId: string,
  kind: CatalogItemKind,
  opts?: CatalogPageOpts,
) => req<CatalogPage<CatalogItem>>(entriesPath(kind, opts), { tenantId });

export const listCatalogSnippets = (
  tenantId: string,
  kind: CatalogSnippetKind,
  opts?: CatalogPageOpts,
) => req<CatalogPage<CatalogSnippet>>(entriesPath(kind, opts), { tenantId });
export const createCatalogItem = (tenantId: string, body: CatalogItemInput) =>
  req<CatalogItem>("/api/personas/active/catalog/items", {
    method: "POST",
    tenantId,
    body: JSON.stringify(body),
  });
export const updateCatalogItem = (
  tenantId: string,
  id: string,
  body: Partial<Omit<CatalogItemInput, "kind">>,
) =>
  req<CatalogItem>(`/api/personas/active/catalog/items/${id}`, {
    method: "PATCH",
    tenantId,
    body: JSON.stringify(body),
  });
export const deleteCatalogItem = (tenantId: string, id: string) =>
  req<void>(`/api/personas/active/catalog/items/${id}`, { method: "DELETE", tenantId });
export const createSnippet = (tenantId: string, body: CatalogSnippetInput) =>
  req<CatalogSnippet>("/api/personas/active/catalog/snippets", {
    method: "POST",
    tenantId,
    body: JSON.stringify(body),
  });
export const updateSnippet = (
  tenantId: string,
  id: string,
  body: Partial<Pick<CatalogSnippet, "title" | "body">>,
) =>
  req<CatalogSnippet>(`/api/personas/active/catalog/snippets/${id}`, {
    method: "PATCH",
    tenantId,
    body: JSON.stringify(body),
  });
export const deleteSnippet = (tenantId: string, id: string) =>
  req<void>(`/api/personas/active/catalog/snippets/${id}`, { method: "DELETE", tenantId });

/** Products only (a service is a 400); png/jpeg/webp, 5 MB max; 503 when the server has
 *  no storage configured. Multipart, so the JSON Content-Type must NOT be set — the
 *  browser has to write its own boundary (same shape as uploadDocument). */
export async function uploadCatalogImage(
  tenantId: string,
  itemId: string,
  file: File,
): Promise<CatalogItem> {
  const { data } = await supabase.auth.getSession();
  const form = new FormData();
  form.append("file", file);
  const path = `/api/personas/active/catalog/items/${itemId}/image`;
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-Tenant-Id": tenantId,
      ...(data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}),
    },
    body: form,
  });
  // Same message shape as req() so callers can pull a FastAPI `detail` out of it.
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

export const deleteCatalogImage = (tenantId: string, itemId: string) =>
  req<CatalogItem>(`/api/personas/active/catalog/items/${itemId}/image`, {
    method: "DELETE",
    tenantId,
  });

// ---- catalog settings (opening hours + appointment grid) ----

export const updateCatalogSettings = (tenantId: string, body: CatalogSettingsInput) =>
  req<CatalogSettings>("/api/personas/active/catalog/settings", {
    method: "PATCH",
    tenantId,
    body: JSON.stringify(body),
  });
// 202 always (idempotent while a run is in flight); 409 "Add knowledge first" when the
// persona has no ready knowledge sources to extract from.
export const triggerExtraction = (tenantId: string) =>
  req<{ status: string }>("/api/personas/active/catalog/extract", { method: "POST", tenantId });

// ---- reviews (persona-scoped) ----

export const listReviews = (tenantId: string) => req<Review[]>("/reviews", { tenantId });
export const decideReview = (
  tenantId: string,
  id: string,
  action: DecisionAction,
  text?: string,
) =>
  req<{ status: string; final_reply: string }>(`/reviews/${id}/decision`, {
    method: "POST",
    tenantId,
    body: JSON.stringify({ action, text: text ?? null }),
  });

// ---- misc ----

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
