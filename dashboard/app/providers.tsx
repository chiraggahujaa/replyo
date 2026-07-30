"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { listPersonas, type Persona } from "@/lib/api";

type Ctx = {
  session: Session | null;
  ready: boolean; // initial auth check done
  personas: Persona[];
  active: Persona | null;
  /** True until this session's first personas fetch settles. While it's true and
   *  `personas` is empty, the right render is "loading", never "no personas yet". */
  personasLoading: boolean;
  setActiveId: (id: string) => void;
  refreshPersonas: () => Promise<Persona[]>;
  signOut: () => Promise<void>;
};

const ReplyoContext = createContext<Ctx | null>(null);
const ACTIVE_KEY = "replyo:active_persona";
// The last-fetched persona list, keyed to its owner. Hydrating from it makes the
// last-used persona active in the very first authenticated paint — the network fetch
// then reconciles quietly instead of gating the whole console behind a spinner (or,
// worse, a flash of "no personas yet"). Keyed by user id so one account's personas
// can never bleed into another account on a shared browser.
const PERSONAS_CACHE_KEY = "replyo:personas:v1";

function readPersonasCache(userId: string): Persona[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PERSONAS_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { userId: owner, personas } = parsed as { userId?: unknown; personas?: unknown };
    if (owner !== userId || !Array.isArray(personas)) return null;
    // Loose shape check — a corrupt cache must degrade to "no cache", never crash render.
    if (!personas.every((p) => p && typeof p.id === "string" && typeof p.name === "string")) {
      return null;
    }
    return personas as Persona[];
  } catch {
    return null;
  }
}

function writePersonasCache(userId: string, personas: Persona[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PERSONAS_CACHE_KEY, JSON.stringify({ userId, personas }));
  } catch {
    /* quota/private mode — cache is an optimization, never required */
  }
}

export function ReplyoProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [personasState, setPersonas] = useState<Persona[]>([]);
  const [personasLoading, setPersonasLoading] = useState(true);
  const [activeId, setActiveIdState] = useState<string | null>(null);

  // Track the Supabase session. Cache hydration happens HERE, in the same state batch
  // as the session itself: by the time `ready` flips and the pages render at all, the
  // cached personas and the stored active id are already in place — the last-used
  // persona is selected in the first frame anyone can see, with zero network involved.
  // (Hydrating from the personas-fetch effect instead would commit one visible frame of
  // "no personas yet" between the session render and the effect's setState.)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        const cached = readPersonasCache(data.session.user.id);
        if (cached && cached.length > 0) {
          setPersonas(cached);
          const stored = localStorage.getItem(ACTIVE_KEY);
          setActiveIdState(cached.find((p) => p.id === stored)?.id ?? cached[0].id);
        }
      }
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const refreshPersonas = useCallback(async () => {
    if (!session) return [];
    const list = await listPersonas();
    setPersonas(list);
    writePersonasCache(session.user.id, list);
    return list;
  }, [session]);

  // Reconcile against the server once signed in; pick the stored active one, or the
  // first. The cache above makes this invisible in the common case — it only changes
  // anything when the list actually changed on another device. The signed-OUT state is
  // DERIVED below (not cleared here), so the effect never calls setState synchronously —
  // it only sets after the fetch resolves.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await listPersonas();
        if (cancelled) return;
        setPersonas(list);
        writePersonasCache(session.user.id, list);
        const stored = typeof window !== "undefined" ? localStorage.getItem(ACTIVE_KEY) : null;
        setActiveIdState(list.find((p) => p.id === stored)?.id ?? list[0]?.id ?? null);
      } catch {
        /* transient — the cached list (if any) keeps the console usable; retry by reload */
      } finally {
        if (!cancelled) setPersonasLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id);
    if (typeof window !== "undefined") localStorage.setItem(ACTIVE_KEY, id);
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    if (typeof window !== "undefined") {
      localStorage.removeItem(ACTIVE_KEY);
      localStorage.removeItem(PERSONAS_CACHE_KEY);
    }
    // Drop the in-memory copy too, and arm the loading flag again — a different account
    // signing in on this same tab must start from "loading", not from the previous
    // account's list or a premature "no personas yet".
    setPersonas([]);
    setActiveIdState(null);
    setPersonasLoading(true);
  }, []);

  // Derive so signing out instantly empties everything with no reset effect.
  const personas = session ? personasState : [];
  const active = session ? personas.find((p) => p.id === activeId) ?? null : null;

  return (
    <ReplyoContext.Provider
      value={{ session, ready, personas, active, personasLoading, setActiveId, refreshPersonas, signOut }}
    >
      {children}
    </ReplyoContext.Provider>
  );
}

export function useReplyo(): Ctx {
  const ctx = useContext(ReplyoContext);
  if (!ctx) throw new Error("useReplyo must be used within ReplyoProvider");
  return ctx;
}
