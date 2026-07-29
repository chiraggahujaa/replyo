"use client";

// Live-updating resource: websocket-pushed invalidations with a polling fallback.
//
// The backend's /ws/admin socket sends slim "something changed" signals (no row data —
// every refetch goes through the authenticated HTTP API, so RLS stays in charge).
// Transport mirrors the chat widget's: polling starts immediately so first data never
// waits on a socket handshake; once the socket is ready, polling drops to a slow
// safety-net cadence; if the socket drops, fast polling resumes while the socket
// retries with exponential backoff — whichever recovers first wins.
//
// Failure modes deliberately covered (each burned us in review):
//   * a refetch that fails while the socket is live retries on a short timer — an
//     invalidation is never silently lost;
//   * the slow safety poll keeps data bounded-fresh even if an event goes missing
//     (e.g. the server's LISTEN connection was mid-reconnect when a row changed);
//   * the server heartbeats every ~25s, and a watchdog closes sockets that have
//     gone silent — a half-open TCP connection after laptop sleep or a network
//     switch can't freeze the page in a fake "Live" state;
//   * waking the tab (visibilitychange/online) resyncs immediately and retries a
//     down socket without waiting out the backoff.

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "./api";
import { supabase } from "./supabase";

const WS_BASE = API_BASE.replace(/^http/, "ws"); // http->ws, https->wss
const INITIAL_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;
// Safety-net poll cadence while the socket is live (push handles the real work).
const LIVE_POLL_MS = 60_000;
// The server pings every ~25s; silence longer than this means the socket is dead
// even if the browser still reports it OPEN.
const STALE_SOCKET_MS = 65_000;
const WATCHDOG_MS = 20_000;

export type LiveStatus = {
  /** The websocket is delivering events (fast polling is off). */
  live: boolean;
  /** Data is flowing at all — the last refetch (pushed or polled) succeeded. */
  connected: boolean;
  /** Manually trigger a refetch through the hook's single-flight coalescer (so a
   *  post-action refresh can't race a pushed refetch out of order). Never rejects. */
  refresh: () => Promise<void>;
};

export function useLiveResource({
  tenantId,
  topic,
  refetch,
  pollMs,
}: {
  tenantId: string;
  topic: "reviews" | "knowledge";
  /** Fetch fresh data; throw on failure (drives `connected`). Called on every poll
   *  tick, on socket ready (to cover the window nobody was listening), and on every
   *  matching change event. */
  refetch: () => Promise<void>;
  /** Fast-poll cadence while the socket is down. */
  pollMs: number;
}): LiveStatus {
  const [live, setLive] = useState(false);
  const [connected, setConnected] = useState(true); // optimistic until a fetch fails
  // The latest refetch closure, without making it an effect dependency — a re-render
  // must never tear the socket down. Written from an effect (not during render) to
  // satisfy react-hooks/refs.
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  });
  // The effect-local coalesced sync, exposed so consumers share its single-flight.
  const syncRef = useRef<(() => Promise<void>) | null>(null);
  const refresh = useCallback(async () => {
    await syncRef.current?.();
  }, []);

  useEffect(() => {
    let destroyed = false;
    let ws: WebSocket | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let backoff = INITIAL_BACKOFF;
    let lastHeard = 0;
    // Single-flight refetch: a burst of change events (e.g. one per crawled page)
    // coalesces into "one in flight + one trailing" instead of a request stampede.
    let fetching = false;
    let dirty = false;

    async function sync() {
      if (fetching) {
        dirty = true;
        return;
      }
      fetching = true;
      try {
        await refetchRef.current();
        if (!destroyed) setConnected(true);
      } catch {
        if (!destroyed) {
          setConnected(false);
          // An invalidation must never be lost to one failed request: retry soon
          // even when the socket is live and only the slow safety poll is running.
          if (!retryTimer) {
            retryTimer = setTimeout(() => {
              retryTimer = null;
              void sync();
            }, pollMs);
          }
        }
      } finally {
        fetching = false;
        if (dirty && !destroyed) {
          dirty = false;
          void sync();
        }
      }
    }
    syncRef.current = sync;

    function startPolling(ms: number) {
      if (destroyed) return;
      if (pollTimer) clearInterval(pollTimer);
      void sync();
      pollTimer = setInterval(() => void sync(), ms);
    }

    function scheduleReconnect() {
      if (destroyed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    }

    function closeSocket(socket: WebSocket) {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }

    async function connect() {
      if (destroyed) return;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      // A fresh token per attempt — a 4401 (expired mid-session) heals on reconnect.
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (destroyed) return;
      if (!token) {
        scheduleReconnect(); // signed out / not yet hydrated; polling carries on
        return;
      }

      let socket: WebSocket;
      try {
        socket = new WebSocket(`${WS_BASE}/ws/admin`);
      } catch {
        scheduleReconnect();
        return;
      }
      ws = socket;
      lastHeard = Date.now(); // fresh baseline so the watchdog can't kill a young socket

      socket.onopen = () => {
        // Auth rides the first frame — browsers can't set headers on a WebSocket,
        // and a message keeps the token out of URLs and server access logs.
        socket.send(JSON.stringify({ type: "auth", token, tenant_id: tenantId }));
      };

      socket.onmessage = (ev) => {
        lastHeard = Date.now();
        let msg: { type?: string; topic?: string };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "ready") {
          backoff = INITIAL_BACKOFF;
          setLive(true);
          startPolling(LIVE_POLL_MS); // push takes over; keep a slow safety net
          if (!watchdogTimer) {
            // The browser can report a dead TCP connection as OPEN indefinitely
            // (sleep/resume, network switch). The server pings every ~25s, so
            // prolonged silence means the socket is a zombie — close it ourselves
            // to force the fallback + reconnect path.
            watchdogTimer = setInterval(() => {
              if (ws && lastHeard && Date.now() - lastHeard > STALE_SOCKET_MS) closeSocket(ws);
            }, WATCHDOG_MS);
          }
        } else if (msg.type === "change" && msg.topic === topic) {
          void sync();
        } else if (msg.type === "refresh") {
          // Server-side "re-pull everything" (oversized event, or the backend's
          // LISTEN connection just recovered and may have missed writes).
          void sync();
        }
        // "ping" needs no reply — hearing it is the point (lastHeard above).
      };

      socket.onclose = (ev) => {
        if (ws !== socket) return; // an old socket's late close event
        ws = null;
        if (destroyed) return;
        setLive(false);
        startPolling(pollMs); // fast fallback while disconnected
        // 4403 = not a member of this persona — retrying can't change that (the
        // polling path will surface the same failure). Everything else retries.
        if (ev.code !== 4403) scheduleReconnect();
      };

      socket.onerror = () => closeSocket(socket);
    }

    function wake() {
      if (destroyed || document.visibilityState === "hidden") return;
      // Coming back from sleep / regaining network: resync now, and if the socket
      // is down, retry it immediately instead of waiting out the backoff.
      void sync();
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        backoff = INITIAL_BACKOFF;
        void connect();
      }
    }

    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);

    startPolling(pollMs); // first data never waits on the socket handshake
    void connect();

    return () => {
      destroyed = true;
      syncRef.current = null;
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      if (pollTimer) clearInterval(pollTimer);
      if (retryTimer) clearTimeout(retryTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      const s = ws;
      ws = null;
      if (s) closeSocket(s);
    };
  }, [tenantId, topic, pollMs]);

  return { live, connected, refresh };
}

/** Stable-identity async callback for `useLiveResource.refetch` — the returned
 *  function reads the latest render's closure without retriggering the effect. */
export function useRefetch(fn: () => Promise<void>): () => Promise<void> {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return useCallback(() => ref.current(), []);
}
