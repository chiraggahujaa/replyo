"use client";

// Contact card — how a customer reaches this business: phone, WhatsApp, email, address,
// website, directions. Extracted from the persona's knowledge like every other catalog
// section, and editable here, because a wrong number is the one mistake a customer acts on
// immediately. Saving PATCHes only `contact`, so claiming the phone number never re-stamps
// the opening hours or the appointment grid as human-edited.
//
// Validation mirrors app/catalog.py's clean_contact_value field for field. It's duplicated
// deliberately: the server is still the authority (its 422 surfaces as a toast), but a typo
// should be caught next to the input that made it, before a round-trip.

import { useEffect, useId, useRef, useState } from "react";
import {
  type BusinessContact,
  type CatalogSettings,
  type ContactField,
  updateCatalogSettings,
} from "@/lib/api";
import { Button, Card, TextArea, TextInput } from "../components/ui";
import { CheckIcon, RefreshIcon } from "../components/icons";
import { Field, StatusBadge, errText } from "./parts";

// Order here is the order on screen AND the order the backend stores (CONTACT_FIELDS).
// `multiline` is the address only — everything else is a single line by construction.
const FIELDS: {
  key: ContactField;
  label: string;
  help: string;
  placeholder: string;
  multiline?: boolean;
  type?: string;
}[] = [
  {
    key: "phone",
    label: "Phone",
    help: "What the assistant gives out when someone asks how to call",
    placeholder: "+91 98765 43210",
    type: "tel",
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    help: "Only if it differs from the phone number",
    placeholder: "+91 98765 43210",
    type: "tel",
  },
  {
    key: "email",
    label: "Email",
    help: "Where customers can write in",
    placeholder: "hello@example.com",
    type: "email",
  },
  {
    key: "address",
    label: "Address",
    help: "One line — the assistant reads it out as written",
    placeholder: "12 MG Road, Bengaluru 560001",
    multiline: true,
  },
  {
    key: "website",
    label: "Website",
    help: "Your own site, not a directory listing",
    placeholder: "example.com",
  },
  {
    key: "maps_url",
    label: "Directions link",
    help: "A map link for “where are you?”",
    placeholder: "https://maps.app.goo.gl/…",
  },
];

const MAX_CHARS = 200; // MAX_CONTACT_VALUE_CHARS
const MIN_PHONE_DIGITS = 6;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const URLISH = /^(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:[/?#]\S*)?$/i;
// The catalog page's two-click confirm window, so destructive-ish actions feel the same
// everywhere in the console.
const CONFIRM_MS = 3200;

type Values = Record<ContactField, string>;

const seedValues = (contact: BusinessContact | null | undefined): Values =>
  FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: contact?.[f.key] ?? "" }), {} as Values);

/** One field's complaint, or null when it's fine. An empty field is always fine — that's
 *  how a detail is left unset (and how an existing one is removed). */
function fieldError(key: ContactField, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.length > MAX_CHARS) return `Keep this under ${MAX_CHARS} characters.`;
  if (key === "phone" || key === "whatsapp") {
    const digits = (value.match(/\d/g) ?? []).length;
    return digits >= MIN_PHONE_DIGITS
      ? null
      : `That needs at least ${MIN_PHONE_DIGITS} digits to be a number someone can dial.`;
  }
  if (key === "email") return EMAIL.test(value) ? null : "That doesn’t look like an email address.";
  if (key === "website" || key === "maps_url")
    return URLISH.test(value) ? null : "That doesn’t look like a web address.";
  return null;
}

export function ContactPanel({
  tenantId,
  settings,
  onSaved,
  onToast,
}: {
  tenantId: string;
  settings: CatalogSettings | null;
  onSaved: (settings: CatalogSettings) => void;
  onToast: (kind: "success" | "error", text: string) => void;
}) {
  const uid = useId();
  // Seeded once per mount, exactly like HoursPanel: the parent remounts this panel when a
  // fresh extraction lands, and a save reconciles from the PATCH response — so nothing can
  // rewrite the form under someone who is halfway through editing it.
  const [values, setValues] = useState<Values>(() => seedValues(settings?.contact));
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  // Off until the first save attempt, so a field you have only just started typing into
  // isn't scolded mid-word.
  const [strict, setStrict] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const set = (key: ContactField, value: string) => setValues((v) => ({ ...v, [key]: value }));

  async function save() {
    if (busy) return;
    setStrict(true);
    const bad = FIELDS.find((f) => fieldError(f.key, values[f.key]));
    if (bad) {
      setFormErr(`${bad.label} needs fixing before these details can be saved.`);
      return;
    }
    // Only non-blank fields are sent: an emptied input is simply absent from the object,
    // which is how the backend records "not stated". Sending every key with "" would be
    // rejected field by field instead.
    const contact: BusinessContact = {};
    for (const f of FIELDS) {
      const value = values[f.key].trim();
      if (value) contact[f.key] = value;
    }
    setBusy(true);
    setFormErr(null);
    try {
      const saved = await updateCatalogSettings(tenantId, { contact });
      setValues(seedValues(saved.contact));
      setStrict(false);
      onSaved(saved);
      onToast("success", "Contact details saved");
    } catch (e) {
      onToast("error", errText(e, "Couldn’t save contact details"));
    } finally {
      setBusy(false);
    }
  }

  // Hand the card back to extraction. `contact: null` clears contact_status, so the next
  // run refills it from the documents — the way out of a save that pinned this persona to
  // details the owner didn't mean to claim (an empty card included).
  async function reset() {
    if (busy) return;
    if (!confirmReset) {
      setConfirmReset(true);
      resetTimer.current = setTimeout(() => setConfirmReset(false), CONFIRM_MS);
      return;
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setConfirmReset(false);
    setBusy(true);
    setFormErr(null);
    try {
      const saved = await updateCatalogSettings(tenantId, { contact: null });
      setValues(seedValues(saved.contact));
      setStrict(false);
      onSaved(saved);
      onToast(
        "success",
        "Contact details handed back to Replyo — run “Re-extract from knowledge” to fill them in",
      );
    } catch (e) {
      onToast("error", errText(e, "Couldn’t reset contact details"));
    } finally {
      setBusy(false);
    }
  }

  // Nothing extracted AND nothing stored: the state where the copy should say so rather
  // than describe a card that's empty on screen.
  const nothingYet = !settings?.contact || Object.keys(settings.contact).length === 0;

  return (
    <div className="stagger space-y-6">
      <Card className="animate-in p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-[16px] font-semibold tracking-tight">
              Contact details
            </h3>
            <p className="mt-1 text-[13px] text-[var(--color-faint)]">
              {settings?.contact_status === "edited"
                ? "These are your own details — re-extracting won’t overwrite them. Reset to auto to read them from your documents again."
                : nothingYet
                  ? "We didn’t find contact details in your documents — add them here, or re-extract if you’ve just added them."
                  : "What the assistant gives out when a customer asks how to reach you."}
            </p>
          </div>
          {settings && <StatusBadge status={settings.contact_status} />}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {FIELDS.map((f) => {
            const err = strict ? fieldError(f.key, values[f.key]) : null;
            const id = `${uid}-${f.key}`;
            return (
              <div key={f.key} className={f.multiline ? "sm:col-span-2" : undefined}>
                <Field label={f.label} htmlFor={id} help={err ? undefined : f.help}>
                  {f.multiline ? (
                    <TextArea
                      id={id}
                      rows={2}
                      maxLength={MAX_CHARS}
                      value={values[f.key]}
                      disabled={busy}
                      onChange={(e) => set(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      className="py-2.5 text-[14px]"
                    />
                  ) : (
                    <TextInput
                      id={id}
                      type={f.type ?? "text"}
                      maxLength={MAX_CHARS}
                      value={values[f.key]}
                      disabled={busy}
                      onChange={(e) => set(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      className="px-3.5 py-2.5 text-[14px]"
                    />
                  )}
                </Field>
                {err && (
                  <p className="animate-in mt-1 text-[12.5px] text-[var(--color-danger)]">{err}</p>
                )}
              </div>
            );
          })}
        </div>

        {formErr && (
          <p className="animate-in mt-4 text-[13px] text-[var(--color-danger)]">{formErr}</p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-[var(--color-border)] pt-4">
          <Button
            size="sm"
            onClick={save}
            loading={busy}
            disabled={busy}
            icon={<CheckIcon className="h-3.5 w-3.5" />}
          >
            Save contact details
          </Button>
          {/* Only meaningful once the owner has claimed the card — until then extraction
              already owns it and there is nothing to hand back. */}
          {settings?.contact_status === "edited" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={reset}
              disabled={busy}
              title="Let Replyo read contact details from your documents again"
              icon={<RefreshIcon className="h-3.5 w-3.5" />}
            >
              {confirmReset ? "Discard these details?" : "Reset to auto"}
            </Button>
          )}
          <span className="text-[12.5px] text-[var(--color-faint)]">
            Leave a field empty to keep it out of replies.
          </span>
        </div>
      </Card>
    </div>
  );
}
