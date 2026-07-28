"use client";

import { useState } from "react";
import { generatePrompt, updatePersona, type Persona } from "@/lib/api";
import { Shell } from "../components/Shell";
import { KnowledgeManager } from "../components/KnowledgeManager";
import { useReplyo } from "../providers";

export default function KnowledgePage() {
  return (
    <Shell>
      <KnowledgeAndPrompt />
    </Shell>
  );
}

function KnowledgeAndPrompt() {
  const { active } = useReplyo();
  if (!active) {
    return <div className="p-8 text-[13px] text-[var(--color-faint)]">Select or create a persona first.</div>;
  }
  // Key by id so the editor reinitialises from the persona on switch, with no reset effect.
  return <Editor key={active.id} active={active} />;
}

function Editor({ active }: { active: Persona }) {
  const { refreshPersonas } = useReplyo();
  const [prompt, setPrompt] = useState(active.system_prompt ?? "");
  const [notes, setNotes] = useState(active.extra_notes ?? "");
  const [busy, setBusy] = useState<"save" | "gen" | null>(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function regen() {
    setBusy("gen");
    setErr(null);
    try {
      const { system_prompt } = await generatePrompt(active!.id, active!.name, notes);
      setPrompt(system_prompt);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't regenerate");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setErr(null);
    setSaved(false);
    try {
      await updatePersona(active!.id, { system_prompt: prompt, extra_notes: notes });
      await refreshPersonas();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8 space-y-8">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">Knowledge base</h1>
        <p className="mt-1 text-[13px] text-[var(--color-faint)]">
          What <span className="font-medium text-[var(--color-text)]">{active.name}</span> answers from.
        </p>
      </div>

      <KnowledgeManager tenantId={active.id} />

      <div className="border-t border-[var(--color-border)] pt-7">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-semibold">System prompt</h2>
            <p className="mt-0.5 text-[12px] text-[var(--color-faint)]">
              The standing instruction, combined with your knowledge at answer time. Edit freely — regenerating never
              overwrites without your click.
            </p>
          </div>
        </div>

        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Notes for regeneration (tone, offers, specifics)…"
          className="mt-3 w-full resize-none rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[12.5px] outline-none focus:border-[var(--color-accent)]"
        />
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={12}
          className="mt-2 w-full resize-y rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 py-3 text-[13px] leading-relaxed outline-none focus:border-[var(--color-accent)] font-mono"
        />

        {err && <p className="mt-2 text-[12.5px] text-rose-500">{err}</p>}
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={save}
            disabled={busy !== null}
            className="rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy === "save" ? "Saving…" : "Save prompt"}
          </button>
          <button
            onClick={regen}
            disabled={busy !== null}
            className="text-[12.5px] font-medium text-[var(--color-accent)] hover:underline disabled:opacity-60"
          >
            {busy === "gen" ? "Regenerating…" : "↻ Regenerate from knowledge"}
          </button>
          {saved && <span className="text-[12.5px] text-emerald-600">Saved ✓</span>}
        </div>
      </div>
    </div>
  );
}
