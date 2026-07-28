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
