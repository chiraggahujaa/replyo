"use client";

import { useState } from "react";
import { generatePrompt, updatePersona, type Persona } from "@/lib/api";
import { Shell } from "../components/Shell";
import { KnowledgeManager } from "../components/KnowledgeManager";
import { Badge, Button, EmptyState, PageHeader, TextArea } from "../components/ui";
import { BookIcon, CheckIcon, RefreshIcon } from "../components/icons";
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
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <EmptyState
          icon={<BookIcon className="h-7 w-7" />}
          title="Select or create a persona first"
          description="Each persona keeps its own knowledge base and system prompt — pick one to start teaching it."
        />
      </div>
    );
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
    <div className="animate-in mx-auto w-full max-w-2xl px-6 py-8 space-y-8">
      <PageHeader
        title="Knowledge base"
        subtitle={
          <>
            What <span className="font-medium text-[var(--color-text)]">{active.name}</span> answers from.
          </>
        }
      />

      <KnowledgeManager tenantId={active.id} />

      <div className="border-t border-[var(--color-border)] pt-7">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-[17px] font-semibold tracking-tight">System prompt</h2>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">
              The standing instruction, combined with your knowledge at answer time. Edit freely — regenerating never
              overwrites without your click.
            </p>
          </div>
        </div>

        <TextArea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Notes for regeneration (tone, offers, specifics)…"
          className="mt-4 resize-none"
        />
        <TextArea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={12}
          className="mt-3 resize-y font-mono text-[13.5px]"
        />

        {err && <p className="animate-in mt-3 text-[13px] text-[var(--color-danger)]">{err}</p>}
        <div className="mt-4 flex items-center gap-3">
          <Button
            onClick={save}
            disabled={busy !== null}
            loading={busy === "save"}
            icon={<CheckIcon className="h-4 w-4" />}
          >
            Save prompt
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={regen}
            disabled={busy !== null}
            loading={busy === "gen"}
            icon={<RefreshIcon className="h-3.5 w-3.5" />}
          >
            Regenerate from knowledge
          </Button>
          {saved && (
            <Badge tone="success" className="animate-pop">
              Saved
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}
