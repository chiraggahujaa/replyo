"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createPersona, generatePrompt, updatePersona } from "@/lib/api";
import { Shell } from "../../components/Shell";
import { KnowledgeManager } from "../../components/KnowledgeManager";
import { Button, Card, PageHeader, TextArea, TextInput, TypingDots } from "../../components/ui";
import {
  ArrowRightIcon,
  CheckIcon,
  CodeIcon,
  RefreshIcon,
  WandIcon,
} from "../../components/icons";
import { useReplyo } from "../../providers";

export default function NewPersonaPage() {
  return (
    <Shell>
      <Wizard />
    </Shell>
  );
}

const STEPS = ["Name", "Knowledge", "Prompt", "Done"];

function Wizard() {
  const { refreshPersonas, setActiveId } = useReplyo();
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function createStep(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const p = await createPersona(name.trim());
      setTenantId(p.id);
      await refreshPersonas();
      setActiveId(p.id);
      setStep(1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create the persona");
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!tenantId) return;
    setBusy(true);
    setErr(null);
    try {
      const { system_prompt } = await generatePrompt(tenantId, name, notes);
      setPrompt(system_prompt);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't generate the prompt");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!tenantId) return;
    setBusy(true);
    setErr(null);
    try {
      await updatePersona(tenantId, {
        system_prompt: prompt,
        extra_notes: notes,
        onboarding_status: "ready",
      });
      await refreshPersonas();
      setStep(3);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <PageHeader title="New persona" />

      {/* Stepper — connected progress rail */}
      <div className="animate-in mb-8 mt-6 flex items-start">
        {STEPS.map((s, i) => (
          <div key={s} className={`flex items-start ${i < STEPS.length - 1 ? "flex-1" : ""}`}>
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`grid h-7 w-7 place-items-center rounded-full text-[11px] font-bold transition-all duration-300 ${
                  i < step
                    ? "bg-[var(--color-success)] text-[var(--on-success)]"
                    : i === step
                      ? "scale-110 bg-cta text-white glow-accent"
                      : "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-faint)]"
                }`}
              >
                {i < step ? <CheckIcon className="h-3.5 w-3.5" /> : i + 1}
              </div>
              <span
                className={`text-[12.5px] ${
                  i === step
                    ? "font-semibold text-[var(--color-text)]"
                    : i < step
                      ? "text-[var(--color-muted)]"
                      : "text-[var(--color-faint)]"
                }`}
              >
                {s}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`mx-2 mt-[13px] h-0.5 flex-1 rounded-full transition-all duration-500 ${
                  i < step ? "bg-[var(--color-success)]" : "bg-[var(--color-border)]"
                }`}
              />
            )}
          </div>
        ))}
      </div>

      {err && <p className="animate-in mb-4 text-[13px] text-[var(--color-danger)]">{err}</p>}

      {/* Step 0 — name */}
      {step === 0 && (
        <Card className="animate-pop p-7">
          <form onSubmit={createStep}>
            <label className="text-[14px] font-semibold">What&apos;s the business called?</label>
            <TextInput
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your business name"
              className="mt-2.5"
            />
            <Button
              loading={busy}
              disabled={!name.trim()}
              icon={<ArrowRightIcon className="h-4 w-4" />}
              className="mt-5"
            >
              Continue
            </Button>
          </form>
        </Card>
      )}

      {/* Step 1 — knowledge + notes */}
      {step === 1 && tenantId && (
        <div className="animate-pop space-y-6">
          <div>
            <h2 className="font-display text-[17px] font-semibold tracking-tight">
              Feed it knowledge
            </h2>
            <p className="mt-1.5 text-[14px] text-[var(--color-muted)]">
              Upload documents and add your website — we&apos;ll deep-crawl it. Add several important URLs if there are
              deep pages a crawler might miss. Ingestion runs in the background; you can continue.
            </p>
          </div>
          <KnowledgeManager tenantId={tenantId} />
          <div>
            <label className="text-[14px] font-semibold">Anything else? (optional)</label>
            <p className="mt-0.5 text-[12.5px] text-[var(--color-faint)]">
              Tone, offers, things not written down anywhere.
            </p>
            <TextArea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Anything the assistant should know or keep in mind…"
              className="mt-2 resize-none"
            />
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => {
                setStep(2);
                if (!prompt) generate();
              }}
              icon={<WandIcon className="h-4 w-4" />}
            >
              Generate prompt
            </Button>
          </div>
        </div>
      )}

      {/* Step 2 — prompt */}
      {step === 2 && (
        <div className="animate-pop space-y-5">
          <div>
            <h2 className="font-display text-[17px] font-semibold tracking-tight">
              Review the assistant&apos;s instructions
            </h2>
            <p className="mt-1.5 text-[14px] text-[var(--color-muted)]">
              We generated this from your knowledge and notes. It&apos;s combined with your documents at answer time —
              edit anything that reads wrong.
            </p>
          </div>
          {/* The textarea stays mounted during generation (disabled + overlay) so focus
              isn't lost and a failed generation degrades back to an editable field. */}
          <div className="relative">
            <TextArea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={14}
              disabled={busy && !prompt}
              placeholder="The system prompt will appear here."
              className="resize-y font-mono text-[13.5px]"
            />
            {busy && !prompt && (
              <div className="glass absolute inset-0 flex items-center justify-center gap-3 rounded-2xl">
                <TypingDots className="text-[var(--color-accent)]" />
                <span className="text-[14px] text-[var(--color-muted)]">
                  Writing your assistant&apos;s instructions…
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={generate}
              loading={busy}
              icon={<RefreshIcon className="h-3.5 w-3.5" />}
            >
              Regenerate
            </Button>
            <Button
              variant="success"
              onClick={save}
              loading={busy}
              disabled={!prompt.trim()}
              icon={<CheckIcon className="h-4 w-4" />}
            >
              Save &amp; finish
            </Button>
          </div>
        </div>
      )}

      {/* Step 3 — done */}
      {step === 3 && (
        <Card className="animate-pop p-9 text-center">
          <div className="animate-float mx-auto grid h-14 w-14 place-items-center rounded-[20px] bg-[var(--color-success)] text-[var(--on-success)] shadow-[0_0_28px_-4px_var(--success)]">
            <CheckIcon className="h-7 w-7" />
          </div>
          <h2 className="mt-5 font-display text-[20px] font-semibold tracking-tight">
            {name} is live
          </h2>
          <p className="mt-1.5 text-[14px] text-[var(--color-muted)]">
            Grab your embed snippet and test the assistant against your own knowledge.
          </p>
          <div className="mt-6 flex justify-center gap-2.5">
            <Button onClick={() => router.push("/install")} icon={<CodeIcon className="h-4 w-4" />}>
              Get the snippet
            </Button>
            <Button variant="secondary" onClick={() => router.push("/queue")}>
              Go to queue
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
