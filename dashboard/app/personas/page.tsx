"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Shell } from "../components/Shell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Modal,
  PageHeader,
  Spinner,
  TextInput,
  ToastShelf,
  type ToastItem,
} from "../components/ui";
import {
  ArrowRightIcon,
  DotsIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
  UsersIcon,
} from "../components/icons";
import { useReplyo } from "../providers";
import { deletePersona, updatePersona, type Persona } from "@/lib/api";

export default function PersonasPage() {
  return (
    <Shell>
      <PersonaList />
    </Shell>
  );
}

/** Surface a FastAPI error `detail` when the response carried one; otherwise fall back. */
function errText(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) {
    const m = e.message.match(/"detail"\s*:\s*"([^"]+)"/);
    return m ? m[1] : fallback;
  }
  return fallback;
}

function PersonaList() {
  const { personas, active, setActiveId, refreshPersonas } = useReplyo();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Persona | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Persona | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);

  const pushToast = useCallback((kind: ToastItem["kind"], text: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  async function togglePause(p: Persona) {
    const next = p.status === "paused" ? "active" : "paused";
    setMenuFor(null);
    setBusyId(p.id);
    try {
      await updatePersona(p.id, { status: next });
      await refreshPersonas();
      pushToast(
        "success",
        next === "paused" ? `${p.name} paused — its widget stops replying` : `${p.name} is live again`,
      );
    } catch (e) {
      pushToast("error", errText(e, "Couldn't update the persona"));
    } finally {
      setBusyId(null);
    }
  }

  async function saveRename(p: Persona, name: string) {
    setBusyId(p.id);
    try {
      await updatePersona(p.id, { name });
      await refreshPersonas();
      setRenameTarget(null);
      pushToast("success", "Persona renamed");
    } catch (e) {
      pushToast("error", errText(e, "Couldn't rename the persona"));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete(p: Persona) {
    setBusyId(p.id);
    try {
      await deletePersona(p.id);
      const rest = await refreshPersonas();
      // If the deleted persona was the console's active one, hand focus to the first
      // that remains (none left -> the provider derives `active: null`).
      if (active?.id === p.id && rest.length) setActiveId(rest[0].id);
      setDeleteTarget(null);
      pushToast("success", `${p.name} deleted`);
    } catch (e) {
      pushToast("error", errText(e, "Couldn't delete the persona"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <PageHeader
        title="Personas"
        subtitle="Each persona is a separate business assistant — its own knowledge, prompt, embed key and queue."
        action={
          <Button href="/personas/new" icon={<PlusIcon className="h-4 w-4" />}>
            New persona
          </Button>
        }
      />

      {personas.length === 0 ? (
        <Card className="animate-in mt-7">
          <EmptyState
            icon={<UsersIcon className="h-7 w-7" />}
            title="No personas yet"
            description="Create your first assistant — it gets its own knowledge, prompt, embed key and queue."
            action={
              <Button href="/personas/new" icon={<PlusIcon className="h-4 w-4" />}>
                New persona
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="stagger mt-7 space-y-3">
          {personas.map((p) => {
            const paused = p.status === "paused";
            return (
              <Card
                key={p.id}
                hover
                // The open menu must paint above the SIBLING cards below, so lift the
                // whole card into its own, higher stacking context while it's open.
                className={`animate-in flex items-center justify-between gap-4 px-5 py-4 ${
                  menuFor === p.id ? "relative z-30" : ""
                }`}
              >
                <div className="flex min-w-0 items-center gap-4">
                  <div
                    className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl font-display text-[17px] font-semibold text-white ${
                      paused ? "bg-[var(--color-faint)]" : "bg-cta"
                    }`}
                  >
                    {p.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`font-display text-[17px] font-semibold tracking-tight ${
                          paused ? "text-[var(--color-muted)]" : ""
                        }`}
                      >
                        {p.name}
                      </span>
                      {active?.id === p.id && (
                        <Badge tone="accent" pulse>
                          Active
                        </Badge>
                      )}
                      {paused && <Badge tone="warning">Paused</Badge>}
                      <Badge tone={p.onboarding_status === "ready" ? "success" : "warning"}>
                        {p.onboarding_status}
                      </Badge>
                    </div>
                    <div className="mt-1 truncate font-mono text-[12.5px] text-[var(--color-faint)]">
                      {p.public_key}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {active?.id !== p.id && (
                    <Button variant="secondary" size="sm" onClick={() => setActiveId(p.id)}>
                      Switch to
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    href="/knowledge"
                    onClick={() => setActiveId(p.id)}
                    icon={<ArrowRightIcon className="h-3.5 w-3.5" />}
                  >
                    Manage
                  </Button>
                  <CardMenu
                    persona={p}
                    open={menuFor === p.id}
                    busy={busyId === p.id}
                    onOpen={() => setMenuFor(p.id)}
                    onClose={() => setMenuFor(null)}
                    onRename={() => {
                      setMenuFor(null);
                      setRenameTarget(p);
                    }}
                    onTogglePause={() => togglePause(p)}
                    onDelete={() => {
                      setMenuFor(null);
                      setDeleteTarget(p);
                    }}
                  />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {renameTarget && (
        <RenameModal
          key={renameTarget.id}
          persona={renameTarget}
          busy={busyId === renameTarget.id}
          onCancel={() => setRenameTarget(null)}
          onSave={(name) => saveRename(renameTarget, name)}
        />
      )}
      {deleteTarget && (
        <DeleteModal
          key={deleteTarget.id}
          persona={deleteTarget}
          busy={busyId === deleteTarget.id}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => confirmDelete(deleteTarget)}
        />
      )}

      <ToastShelf toasts={toasts} />
    </div>
  );
}

/* ---- per-card actions menu ---------------------------------------------------------- */

function CardMenu({
  persona,
  open,
  busy,
  onOpen,
  onClose,
  onRename,
  onTogglePause,
  onDelete,
}: {
  persona: Persona;
  open: boolean;
  busy: boolean;
  onOpen: () => void;
  onClose: () => void;
  onRename: () => void;
  onTogglePause: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const paused = persona.status === "paused";

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, onClose]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => (open ? onClose() : onOpen())}
        disabled={busy}
        title={`Actions for ${persona.name}`}
        aria-label={`Actions for ${persona.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-faint)] transition-colors hover:bg-[var(--accent-wash)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-55"
      >
        {busy ? <Spinner className="h-4 w-4" /> : <DotsIcon className="h-4.5 w-4.5" />}
      </button>

      {open && (
        // Opaque surface (not `glass`) — same lesson as the persona switcher popover.
        <div
          role="menu"
          className="animate-pop absolute right-0 z-20 mt-1.5 w-56 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-xl"
        >
          <MenuItem icon={<PencilIcon className="h-4 w-4" />} label="Rename" onClick={onRename} />
          <MenuItem
            icon={paused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
            label={paused ? "Resume" : "Pause"}
            hint={paused ? "The widget starts replying again" : "The widget stops replying"}
            onClick={onTogglePause}
          />
          <div className="mx-3 my-1 border-t border-[var(--color-border)]" />
          <MenuItem
            icon={<TrashIcon className="h-4 w-4" />}
            label="Delete"
            hint="Knowledge, queue and key are removed"
            danger
            onClick={onDelete}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  danger = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors ${
        danger
          ? "text-[var(--color-danger)] hover:bg-[var(--danger-wash)]"
          : "text-[var(--color-text)] hover:bg-[var(--accent-wash)]"
      }`}
    >
      <span className={`mt-0.5 shrink-0 ${danger ? "" : "text-[var(--color-muted)]"}`}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[14px] font-medium">{label}</span>
        {hint && (
          <span
            className={`block text-[12px] ${
              danger ? "text-[var(--color-danger)]/70" : "text-[var(--color-faint)]"
            }`}
          >
            {hint}
          </span>
        )}
      </span>
    </button>
  );
}

/* ---- dialogs ------------------------------------------------------------------------- */

function RenameModal({
  persona,
  busy,
  onCancel,
  onSave,
}: {
  persona: Persona;
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(persona.name);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed !== persona.name;

  return (
    <Modal open onClose={onCancel} title="Rename persona">
      <p className="mt-1.5 text-[13.5px] text-[var(--color-muted)]">
        Shown across the console, and as the widget&apos;s header unless the Install page
        set a custom widget name.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) onSave(trimmed);
        }}
      >
        <TextInput
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Persona name"
          className="mt-4"
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!valid}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteModal({
  persona,
  busy,
  onCancel,
  onConfirm,
}: {
  persona: Persona;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const match = confirm.trim().toLowerCase() === persona.name.trim().toLowerCase();

  return (
    <Modal open onClose={onCancel} title={`Delete ${persona.name}?`}>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--color-muted)]">
        This permanently removes its knowledge, review queue, conversations and scheduled
        follow-ups, and its embed key stops working anywhere it&apos;s installed. This
        cannot be undone. Prefer a break? Pause it instead.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (match && !busy) onConfirm();
        }}
      >
        <label className="mt-4 block text-[13px] text-[var(--color-muted)]">
          Type <span className="font-semibold text-[var(--color-text)]">{persona.name}</span> to
          confirm.
        </label>
        <TextInput
          autoFocus
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={persona.name}
          className="mt-2"
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!match}>
            Delete persona
          </Button>
        </div>
      </form>
    </Modal>
  );
}
