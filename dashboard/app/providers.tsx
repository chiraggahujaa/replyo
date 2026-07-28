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
  setActiveId: (id: string) => void;
  refreshPersonas: () => Promise<Persona[]>;
  signOut: () => Promise<void>;
};

const ReplyoContext = createContext<Ctx | null>(null);
const ACTIVE_KEY = "replyo:active_persona";

export function ReplyoProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [personasState, setPersonas] = useState<Persona[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);

  // Track the Supabase session.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
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
    return list;
  }, [session]);

  // Load personas once signed in; pick the stored active one, or the first. The signed
  // -OUT state is DERIVED below (not cleared here), so the effect never calls setState
  // synchronously — it only sets after the fetch resolves.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await listPersonas();
        if (cancelled) return;
        setPersonas(list);
        const stored = typeof window !== "undefined" ? localStorage.getItem(ACTIVE_KEY) : null;
        setActiveIdState(list.find((p) => p.id === stored)?.id ?? list[0]?.id ?? null);
      } catch {
        /* transient — the user can retry */
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
    if (typeof window !== "undefined") localStorage.removeItem(ACTIVE_KEY);
  }, []);

  // Derive so signing out instantly empties everything with no reset effect.
  const personas = session ? personasState : [];
  const active = session ? personas.find((p) => p.id === activeId) ?? null : null;

  return (
    <ReplyoContext.Provider
      value={{ session, ready, personas, active, setActiveId, refreshPersonas, signOut }}
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
