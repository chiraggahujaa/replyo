// Thin client for the Replyo FastAPI backend.

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "http://localhost:8000";

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

export async function listReviews(): Promise<Review[]> {
  const res = await fetch(`${API_BASE}/reviews`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /reviews failed: ${res.status}`);
  return res.json();
}

export async function decideReview(
  id: string,
  action: DecisionAction,
  text?: string,
): Promise<{ status: string; final_reply: string }> {
  const res = await fetch(`${API_BASE}/reviews/${id}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, text: text ?? null }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Decision failed (${res.status}): ${detail}`);
  }
  return res.json();
}

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
