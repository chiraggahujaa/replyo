"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createPersona, generatePrompt, updatePersona } from "@/lib/api";
import { Shell } from "../../components/Shell";
import { KnowledgeManager } from "../../components/KnowledgeManager";
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

  async function createStep(e: React.FormEvent) {
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
      <h1 className="text-[20px] font-semibold tracking-tight">New persona</h1>

      {/* Stepper */}
      <div className="mt-5 mb-7 flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold ${
                i < step
                  ? "bg-emerald-500 text-white"
                  : i === step
                    ? "bg-[var(--color-accent)] text-white"
                    : "bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-faint)]"
              }`}
            >
              {i < step ? "✓" : i + 1}
            </div>
            <span className={`text-[12.5px] ${i === step ? "font-semibold" : "text-[var(--color-faint)]"}`}>{s}</span>
            {i < STEPS.length - 1 && <div className="w-6 h-px bg-[var(--color-border)]" />}
          </div>
        ))}
      </div>

      {err && <p className="mb-4 text-[12.5px] text-rose-500">{err}</p>}

      {/* Step 0 — name */}
      {step === 0 && (
        <form onSubmit={createStep} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <label className="text-[13px] font-semibold">What&apos;s the business called?</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. BrightSmile Dental"
            className="mt-2 w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[14px] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--ring)]"
          />
          <button
            disabled={busy || !name.trim()}
            className="mt-4 rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-[13.5px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Creating…" : "Continue"}
          </button>
        </form>
      )}

      {/* Step 1 — knowledge + notes */}
      {step === 1 && tenantId && (
        <div className="space-y-5">
          <div>
            <h2 className="text-[15px] font-semibold">Feed it knowledge</h2>
            <p className="mt-1 text-[12.5px] text-[var(--color-faint)]">
              Upload documents and add your website — we&apos;ll deep-crawl it. Add several important URLs if there are
              deep pages a crawler might miss. Ingestion runs in the background; you can continue.
            </p>
          </div>
          <KnowledgeManager tenantId={tenantId} />
          <div>
            <label className="text-[13px] font-semibold">Anything else? (optional)</label>
            <p className="text-[12px] text-[var(--color-faint)]">Tone, offers, things not written down anywhere.</p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="e.g. Friendly and fast. Emphasise same-day emergencies. Never quote for gas fitting."
              className="mt-1.5 w-full resize-none rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[13.5px] outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => {
                setStep(2);
                if (!prompt) generate();
              }}
              className="rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-[13.5px] font-semibold text-white hover:opacity-90"
            >
              Generate prompt
            </button>
          </div>
        </div>
      )}

      {/* Step 2 — prompt */}
      {step === 2 && (
        <div className="space-y-4">
          <div>
            <h2 className="text-[15px] font-semibold">Review the assistant&apos;s instructions</h2>
            <p className="mt-1 text-[12.5px] text-[var(--color-faint)]">
              We generated this from your knowledge and notes. It&apos;s combined with your documents at answer time —
              edit anything that reads wrong.
            </p>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={14}
            placeholder={busy ? "Generating…" : "The system prompt will appear here."}
            className="w-full resize-y rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 py-3 text-[13px] leading-relaxed outline-none focus:border-[var(--color-accent)] font-mono"
          />
          <div className="flex items-center justify-between">
            <button onClick={generate} disabled={busy} className="text-[12.5px] font-medium text-[var(--color-accent)] hover:underline disabled:opacity-60">
              ↻ Regenerate
            </button>
            <button
              onClick={save}
              disabled={busy || !prompt.trim()}
              className="rounded-xl bg-emerald-600 px-5 py-2.5 text-[13.5px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save & finish"}
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — done */}
      {step === 3 && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-emerald-500 text-white text-[20px]">✓</div>
          <h2 className="mt-4 text-[17px] font-semibold tracking-tight">{name} is live</h2>
          <p className="mt-1 text-[13px] text-[var(--color-faint)]">
            Grab your embed snippet and test the assistant against your own knowledge.
          </p>
          <div className="mt-5 flex justify-center gap-2.5">
            <button
              onClick={() => router.push("/install")}
              className="rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-[13.5px] font-semibold text-white hover:opacity-90"
            >
              Get the snippet & test it
            </button>
            <button
              onClick={() => router.push("/")}
              className="rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-2.5 text-[13.5px] font-semibold hover:bg-[var(--color-bg-soft)]"
            >
              Go to queue
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
