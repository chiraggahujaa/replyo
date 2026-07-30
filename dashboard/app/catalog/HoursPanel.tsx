"use client";

// Hours & booking — the two facts the assistant needs before it can offer anyone a time:
// when the business is open, and how a day is chopped into appointments. Both arrive from
// extraction and are editable here. The two sections save independently and each PATCH
// carries only the fields its own section owns, so correcting Tuesday's closing time
// never re-stamps the appointment grid as human-edited (and vice versa).

import { useId, useState } from "react";
import {
  type BusinessHours,
  type CatalogSettings,
  updateCatalogSettings,
} from "@/lib/api";
import { Button, Card, TextInput } from "../components/ui";
import { CheckIcon, CopyIcon } from "../components/icons";
import { Field, StatusBadge, errText } from "./parts";

// "0" is Monday, matching the backend's keying (Python's weekday(), not JS getDay()).
const DAYS = [
  { key: "0", label: "Monday" },
  { key: "1", label: "Tuesday" },
  { key: "2", label: "Wednesday" },
  { key: "3", label: "Thursday" },
  { key: "4", label: "Friday" },
  { key: "5", label: "Saturday" },
  { key: "6", label: "Sunday" },
] as const;

// Tue–Fri: "copy Monday to all weekdays" deliberately leaves the weekend alone, which is
// usually the row that differs.
const WEEKDAY_KEYS = ["1", "2", "3", "4"];

const DEFAULT_SLOT = 30;
const DEFAULT_BUFFER = 0;
const SLOT_MIN = 5;
const SLOT_MAX = 240;
const BUFFER_MIN = 0;
const BUFFER_MAX = 60;

type Row = { closed: boolean; open: string; close: string };
type Rows = Record<string, Row>;

function seedRows(hours: BusinessHours | null | undefined): Rows {
  const rows: Rows = {};
  for (const d of DAYS) {
    const h = hours?.[d.key];
    rows[d.key] = h
      ? { closed: false, open: h.open ?? "", close: h.close ?? "" }
      : { closed: true, open: "", close: "" };
  }
  return rows;
}

/** "HH:MM" -> minutes past midnight, or null when it isn't a real time. */
function toMinutes(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

/** One row's complaint, or null when it's fine. `requireBoth` is off until the first save
 *  attempt so a day you just flipped open doesn't scold you before you've typed. */
function rowError(row: Row, requireBoth: boolean): string | null {
  if (row.closed) return null;
  const open = toMinutes(row.open);
  const close = toMinutes(row.close);
  if (open === null || close === null)
    return requireBoth ? "Add both an opening and a closing time." : null;
  if (close <= open) return "Closing time must be after the opening time.";
  return null;
}

/** Whole minutes inside [lo, hi], or null — validated, not clamped, so an out-of-range
 *  entry gets told rather than silently rewritten. */
function parseMinutes(raw: string, lo: number, hi: number): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

export function HoursPanel({
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
  // Seeded once per mount. The parent remounts this panel when a fresh extraction lands,
  // and each save reconciles its own section from the PATCH response below — so nothing
  // else can rewrite the form under someone who is halfway through editing it.
  const [rows, setRows] = useState<Rows>(() => seedRows(settings?.hours));
  const [slot, setSlot] = useState(String(settings?.slot_minutes ?? DEFAULT_SLOT));
  const [buffer, setBuffer] = useState(String(settings?.buffer_minutes ?? DEFAULT_BUFFER));
  const [busy, setBusy] = useState<"hours" | "settings" | null>(null);
  const [hoursErr, setHoursErr] = useState<string | null>(null);
  const [settingsErr, setSettingsErr] = useState<string | null>(null);
  const [strictRows, setStrictRows] = useState(false);

  const patchRow = (key: string, p: Partial<Row>) =>
    setRows((r) => ({ ...r, [key]: { ...r[key], ...p } }));

  const copyMonday = () =>
    setRows((r) => {
      const next = { ...r };
      for (const k of WEEKDAY_KEYS) next[k] = { ...r["0"] };
      return next;
    });

  async function saveHours() {
    if (busy) return;
    setStrictRows(true);
    const bad = DAYS.find((d) => rowError(rows[d.key], true));
    if (bad) {
      setHoursErr(`${bad.label} needs fixing before these hours can be saved.`);
      return;
    }
    // A day left closed must serialize as null for that key — never {open:"",close:""}.
    const hours: BusinessHours = {};
    for (const d of DAYS) {
      const r = rows[d.key];
      hours[d.key] = r.closed ? null : { open: r.open, close: r.close };
    }
    setBusy("hours");
    setHoursErr(null);
    try {
      const saved = await updateCatalogSettings(tenantId, { hours });
      setRows(seedRows(saved.hours));
      setStrictRows(false);
      onSaved(saved);
      onToast("success", "Opening hours saved");
    } catch (e) {
      onToast("error", errText(e, "Couldn't save opening hours"));
    } finally {
      setBusy(null);
    }
  }

  async function saveSettings() {
    if (busy) return;
    const slotMin = parseMinutes(slot, SLOT_MIN, SLOT_MAX);
    if (slotMin === null) {
      setSettingsErr(
        `Appointment length must be a whole number of minutes between ${SLOT_MIN} and ${SLOT_MAX}.`,
      );
      return;
    }
    const bufferMin = parseMinutes(buffer, BUFFER_MIN, BUFFER_MAX);
    if (bufferMin === null) {
      setSettingsErr(
        `Buffer must be a whole number of minutes between ${BUFFER_MIN} and ${BUFFER_MAX}.`,
      );
      return;
    }
    setBusy("settings");
    setSettingsErr(null);
    try {
      const saved = await updateCatalogSettings(tenantId, {
        slot_minutes: slotMin,
        buffer_minutes: bufferMin,
      });
      setSlot(String(saved.slot_minutes));
      setBuffer(String(saved.buffer_minutes));
      onSaved(saved);
      onToast("success", "Appointment settings saved");
    } catch (e) {
      onToast("error", errText(e, "Couldn't save appointment settings"));
    } finally {
      setBusy(null);
    }
  }

  const neverExtracted = !settings?.hours;

  return (
    <div className="stagger space-y-6">
      {/* ---- Opening hours ---- */}
      <Card className="animate-in p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-[16px] font-semibold tracking-tight">Opening hours</h3>
            <p className="mt-1 text-[13px] text-[var(--color-faint)]">
              {neverExtracted
                ? "We didn’t find opening hours in your documents — set them here."
                : "The days and times the assistant tells customers you’re open."}
            </p>
          </div>
          {settings && <StatusBadge status={settings.hours_status} />}
        </div>

        <div className="mt-4 space-y-3">
          {DAYS.map((d) => {
            const row = rows[d.key];
            const err = rowError(row, strictRows);
            return (
              <div
                key={d.key}
                className="border-t border-[var(--color-border)] pt-3 first:border-t-0 first:pt-0"
              >
                <div className="flex flex-wrap items-center gap-2.5">
                  <span
                    className={`w-[5.5rem] shrink-0 text-[13.5px] font-semibold ${
                      row.closed ? "text-[var(--color-faint)]" : ""
                    }`}
                  >
                    {d.label}
                  </span>
                  <OpenToggle
                    day={d.label}
                    open={!row.closed}
                    disabled={busy !== null}
                    onChange={(open) => patchRow(d.key, { closed: !open })}
                  />
                  <div className="flex min-w-[13rem] flex-1 items-center gap-2">
                    <TextInput
                      type="time"
                      aria-label={`${d.label} opening time`}
                      value={row.open}
                      disabled={row.closed || busy !== null}
                      onChange={(e) => patchRow(d.key, { open: e.target.value })}
                      className="min-w-0 flex-1 px-3 py-2 text-[13.5px]"
                    />
                    <span aria-hidden className="text-[var(--color-faint)]">
                      –
                    </span>
                    <TextInput
                      type="time"
                      aria-label={`${d.label} closing time`}
                      value={row.close}
                      disabled={row.closed || busy !== null}
                      onChange={(e) => patchRow(d.key, { close: e.target.value })}
                      className="min-w-0 flex-1 px-3 py-2 text-[13.5px]"
                    />
                  </div>
                </div>
                {err && (
                  <p className="animate-in mt-1.5 text-[12.5px] text-[var(--color-danger)] sm:pl-[6.5rem]">
                    {err}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {hoursErr && <p className="animate-in mt-4 text-[13px] text-[var(--color-danger)]">{hoursErr}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-[var(--color-border)] pt-4">
          <Button
            size="sm"
            onClick={saveHours}
            loading={busy === "hours"}
            disabled={busy !== null}
            icon={<CheckIcon className="h-3.5 w-3.5" />}
          >
            Save hours
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={copyMonday}
            disabled={busy !== null || rows["0"].closed}
            title={
              rows["0"].closed
                ? "Set Monday’s hours first"
                : "Apply Monday’s hours to Tuesday–Friday"
            }
            icon={<CopyIcon className="h-3.5 w-3.5" />}
          >
            Copy Monday to all weekdays
          </Button>
        </div>
      </Card>

      {/* ---- Appointment settings ---- */}
      <Card className="animate-in p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-[16px] font-semibold tracking-tight">
              Appointment settings
            </h3>
            <p className="mt-1 text-[13px] text-[var(--color-faint)]">
              These drive the times the assistant offers customers — it walks your opening hours in
              these steps.
            </p>
          </div>
          {settings && <StatusBadge status={settings.settings_status} />}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label="Appointment length (min)"
            htmlFor={`${uid}-slot`}
            help="How long one appointment takes"
          >
            <TextInput
              id={`${uid}-slot`}
              type="number"
              min={SLOT_MIN}
              max={SLOT_MAX}
              inputMode="numeric"
              value={slot}
              disabled={busy !== null}
              onChange={(e) => setSlot(e.target.value)}
              placeholder={String(DEFAULT_SLOT)}
              className="px-3.5 py-2.5 text-[14px]"
            />
          </Field>
          <Field
            label="Buffer (min)"
            htmlFor={`${uid}-buffer`}
            help="Gap between appointments"
          >
            <TextInput
              id={`${uid}-buffer`}
              type="number"
              min={BUFFER_MIN}
              max={BUFFER_MAX}
              inputMode="numeric"
              value={buffer}
              disabled={busy !== null}
              onChange={(e) => setBuffer(e.target.value)}
              placeholder={String(DEFAULT_BUFFER)}
              className="px-3.5 py-2.5 text-[14px]"
            />
          </Field>
        </div>

        {settingsErr && (
          <p className="animate-in mt-4 text-[13px] text-[var(--color-danger)]">{settingsErr}</p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-[var(--color-border)] pt-4">
          <Button
            size="sm"
            onClick={saveSettings}
            loading={busy === "settings"}
            disabled={busy !== null}
            icon={<CheckIcon className="h-3.5 w-3.5" />}
          >
            Save settings
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** Closed/Open for one weekday — the same segmented-pill idiom as the Tabs control, at
 *  row scale. Two buttons rather than a checkbox so the current state is legible without
 *  having to read a label. */
function OpenToggle({
  day,
  open,
  disabled,
  onChange,
}: {
  day: string;
  open: boolean;
  disabled?: boolean;
  onChange: (open: boolean) => void;
}) {
  return (
    <div className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-soft)] p-1">
      {[
        { on: true, label: "Open" },
        { on: false, label: "Closed" },
      ].map((o) => (
        <button
          key={o.label}
          type="button"
          disabled={disabled}
          aria-pressed={open === o.on}
          aria-label={`${day}: ${o.label}`}
          onClick={() => onChange(o.on)}
          className={`rounded-full px-3 py-1 text-[12.5px] font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-55 ${
            open === o.on
              ? "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm"
              : "border border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
