"use client";

// Install — a per-tenant widget customizer. Every control edits the same config that
// (a) renders the embed snippet on the right and (b) re-injects the REAL widget onto
// this page, so what the user copies is exactly what they just previewed. The widget
// itself reads all of this from data attributes (see app/static/widget.js), so the
// snippet stays a single self-contained tag.

import { useEffect, useRef, useState } from "react";
import { API_BASE, updatePersona } from "@/lib/api";
import { Shell } from "../components/Shell";
import { useReplyo } from "../providers";
import { Badge, Button, Card, EmptyState, PageHeader, TextInput } from "../components/ui";
import {
  CheckIcon,
  CodeIcon,
  CopyIcon,
  KeyIcon,
  MoonIcon,
  RefreshIcon,
  SunIcon,
} from "../components/icons";

/* ---- Options (mirrors the presets in app/static/widget.js) ------------------------ */

const THEMES = [
  { id: "teal", label: "Teal", a: "#0f766e", b: "#14b8a6", deep: "#0f766e" },
  { id: "ocean", label: "Ocean", a: "#1d4ed8", b: "#38bdf8", deep: "#1d4ed8" },
  { id: "violet", label: "Violet", a: "#6d28d9", b: "#a78bfa", deep: "#6d28d9" },
  { id: "sunset", label: "Sunset", a: "#9a3412", b: "#c2410c", deep: "#c2410c" },
  { id: "rose", label: "Rose", a: "#be185d", b: "#fb7185", deep: "#be185d" },
  { id: "forest", label: "Forest", a: "#15803d", b: "#22c55e", deep: "#166534" },
  { id: "crimson", label: "Crimson", a: "#b91c1c", b: "#ef4444", deep: "#991b1b" },
  { id: "slate", label: "Slate", a: "#334155", b: "#64748b", deep: "#1e293b" },
] as const;
type ThemeId = (typeof THEMES)[number]["id"];

// The widget's two surface modes, used to paint the theme swatches so each palette
// previews exactly how it will sit on the chosen mode.
const MODE_SURFACES = {
  light: { logBg: "#f8fafc", aiBg: "#ffffff", aiBorder: "#e3e8ef" },
  dark: { logBg: "#0b1120", aiBg: "#1e293b", aiBorder: "#334155" },
} as const;
type ModeId = keyof typeof MODE_SURFACES;

const SIZES = {
  compact: { w: 330, h: 480, bubble: 48, label: "Compact" },
  standard: { w: 374, h: 560, bubble: 56, label: "Standard" },
  large: { w: 420, h: 640, bubble: 64, label: "Large" },
} as const;
type SizeId = keyof typeof SIZES | "custom";

// Hard bounds the widget enforces for exact sizing / offsets; the sliders mirror them.
const MIN_W = 320;
const MAX_W = 480;
const MIN_H = 420;
const MAX_H = 720;
const MAX_OFFSET = 200;
const DEFAULT_OFFSET = 20;

const POSITIONS = [
  { id: "bottom-right", label: "Bottom right" },
  { id: "bottom-left", label: "Bottom left" },
  { id: "top-right", label: "Top right" },
  { id: "top-left", label: "Top left" },
] as const;
type PositionId = (typeof POSITIONS)[number]["id"];

type WidgetConfig = {
  name: string;
  theme: ThemeId;
  mode: ModeId;
  size: SizeId;
  width: number;
  height: number;
  position: PositionId;
  offsetX: number;
  offsetY: number;
};

function defaultConfig(personaName: string): WidgetConfig {
  return {
    name: personaName,
    theme: "teal",
    mode: "light",
    size: "standard",
    width: SIZES.standard.w,
    height: SIZES.standard.h,
    position: "bottom-right",
    offsetX: DEFAULT_OFFSET,
    offsetY: DEFAULT_OFFSET,
  };
}

/* ---- Persistence -------------------------------------------------------------------- */

const CFG_PREFIX = "replyo:widget:cfg:";
const storageKey = (publicKey: string) => CFG_PREFIX + publicKey;

// Read every persona's saved customization once, in a lazy useState initializer (the
// v16-preferred alternative to setState-in-effect). Nothing here renders until personas
// have loaded client-side, so the empty SSR result can't cause a hydration mismatch.
function loadAllStored(): Record<string, Partial<WidgetConfig>> {
  if (typeof window === "undefined") return {};
  const out: Record<string, Partial<WidgetConfig>> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(CFG_PREFIX)) continue;
    try {
      out[k.slice(CFG_PREFIX.length)] = JSON.parse(localStorage.getItem(k) || "");
    } catch {
      /* corrupted entry — ignore, defaults apply */
    }
  }
  return out;
}

const clampNum = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;

// Stored values are untrusted (old schema, hand-edited): drop anything invalid so the
// UI never renders a selection the widget would ignore.
function mergeConfig(defaults: WidgetConfig, stored?: Partial<WidgetConfig>): WidgetConfig {
  const m: WidgetConfig = { ...defaults, ...stored };
  if (typeof m.name !== "string") m.name = defaults.name;
  if (!THEMES.some((t) => t.id === m.theme)) m.theme = defaults.theme;
  if (m.mode !== "light" && m.mode !== "dark") m.mode = defaults.mode;
  if (m.size !== "custom" && !Object.keys(SIZES).includes(m.size)) m.size = defaults.size;
  if (!POSITIONS.some((p) => p.id === m.position)) m.position = defaults.position;
  m.width = clampNum(m.width, MIN_W, MAX_W, defaults.width);
  m.height = clampNum(m.height, MIN_H, MAX_H, defaults.height);
  m.offsetX = clampNum(m.offsetX, 0, MAX_OFFSET, defaults.offsetX);
  m.offsetY = clampNum(m.offsetY, 0, MAX_OFFSET, defaults.offsetY);
  return m;
}

/* ---- Snippet ------------------------------------------------------------------------ */

// One attribute list drives BOTH the displayed/copied snippet and the live preview
// injection, so the two can never drift apart. In the snippet, defaults are omitted to
// keep the tag small — unpinned fields then follow the server-saved config wherever
// the tag is embedded. The PREVIEW passes pinAll so it always renders this page's
// pending state: its injected widget refetches /widget/config on boot, which would
// otherwise repaint a default-valued field back to the not-yet-saved server value
// (the PATCH is debounced longer than the injection).
function buildAttrs(cfg: WidgetConfig, personaName: string, publicKey: string, pinAll = false) {
  const attrs: [string, string][] = [
    ["src", `${API_BASE}/widget/widget.js`],
    ["data-api", API_BASE],
    ["data-tenant", publicKey],
    ["data-name", cfg.name.trim() || personaName],
  ];
  if (pinAll || cfg.theme !== "teal") attrs.push(["data-theme", cfg.theme]);
  if (pinAll || cfg.mode !== "light") attrs.push(["data-mode", cfg.mode]);
  if (cfg.size === "custom") {
    // data-size="custom" pins the sizing MODE too — without it a later console preset
    // change would regrow a pasted custom embed's launcher bubble.
    attrs.push(
      ["data-size", "custom"],
      ["data-width", String(cfg.width)],
      ["data-height", String(cfg.height)],
    );
  } else if (pinAll || cfg.size !== "standard") {
    attrs.push(["data-size", cfg.size]);
  }
  if (pinAll || cfg.position !== "bottom-right") attrs.push(["data-position", cfg.position]);
  if (pinAll || cfg.offsetX !== DEFAULT_OFFSET) attrs.push(["data-offset-x", String(cfg.offsetX)]);
  if (pinAll || cfg.offsetY !== DEFAULT_OFFSET) attrs.push(["data-offset-y", String(cfg.offsetY)]);
  return attrs;
}

const escapeAttr = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const snippetText = (attrs: [string, string][]) =>
  "<script\n" + attrs.map(([k, v]) => `  ${k}="${escapeAttr(v)}"`).join("\n") + "\n></script>";

/* ---- Page ----------------------------------------------------------------------------- */

export default function InstallPage() {
  return (
    <Shell>
      <Install />
    </Shell>
  );
}

function Install() {
  const { active, refreshPersonas } = useReplyo();
  const [copied, setCopied] = useState(false);
  // Edits made in this mount (plus live cross-tab writes, merged by the storage
  // listener). Deliberately NOT seeded from localStorage: the server config is
  // canonical across devices, so a stale cached copy must never outrank it — or
  // silently resurrect a Reset made on another device.
  const [configs, setConfigs] = useState<Record<string, Partial<WidgetConfig>>>({});
  // Pre-feature localStorage customizations, read once: consulted only when the server
  // row has no config at all (null/absent), so old local setups carry over and get
  // promoted to the server on the next tweak.
  const [legacy] = useState<Record<string, Partial<WidgetConfig>>>(loadAllStored);
  // Backend sync of the customization (what makes plain embeds follow the console).
  const [sync, setSync] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // All widget_config writes flow through one promise chain, so a Reset can never be
  // overtaken by a debounced save that was already in flight.
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const scriptRef = useRef<HTMLScriptElement | null>(null);

  // Derived during render — no load effect, no flash, safe across persona switches.
  // This session's edits win; then the persona's server-saved config; then the legacy
  // local cache; defaults cover a fresh persona. (?? skips only null/undefined, so a
  // server-side reset — widget_config = {} — correctly masks the legacy layer.)
  const value = active
    ? mergeConfig(
        defaultConfig(active.name),
        configs[active.public_key] ??
          ((active.widget_config ?? legacy[active.public_key]) as
            | Partial<WidgetConfig>
            | undefined),
      )
    : null;
  const cfgKey = value ? JSON.stringify(value) : "";
  const attrs = active && value ? buildAttrs(value, active.name, active.public_key) : [];
  const snippet = snippetText(attrs);

  // Live preview: (re-)inject the real widget with the current attributes, debounced so
  // slider drags don't reload it on every pixel. The widget's own single-instance guard
  // tears down the previous instance when the new script executes.
  useEffect(() => {
    if (!active || !cfgKey) return;
    const t = setTimeout(() => {
      const cfg = mergeConfig(defaultConfig(active.name), JSON.parse(cfgKey));
      scriptRef.current?.remove();
      const s = document.createElement("script");
      for (const [k, v] of buildAttrs(cfg, active.name, active.public_key, true))
        s.setAttribute(k, v);
      document.body.appendChild(s);
      scriptRef.current = s;
    }, 250);
    return () => clearTimeout(t);
  }, [cfgKey, active?.public_key, active?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // On unmount, dispose the widget entirely (socket, timers, host node).
  useEffect(
    () => () => {
      scriptRef.current?.remove();
      const w = (window as unknown as { __replyoWidget?: { teardown?: () => void } })
        .__replyoWidget;
      w?.teardown?.();
    },
    []
  );

  // A pending debounced save must not land on a different persona (or after unmount).
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [active?.id]
  );

  // Another tab editing the same persona writes the whole config object; merge ONLY
  // the key that changed (a live cross-tab edit is fresher than the server row we
  // hold). Bulk re-reading every stored entry here would resurrect stale configs from
  // old sessions — the exact staleness the empty `configs` initializer avoids.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null) {
        setConfigs({});
        return;
      }
      if (!e.key.startsWith(CFG_PREFIX)) return;
      const pk = e.key.slice(CFG_PREFIX.length);
      let cfg: Partial<WidgetConfig> | undefined;
      try {
        cfg = e.newValue ? JSON.parse(e.newValue) : undefined;
      } catch {
        return; // corrupted write — ignore
      }
      setConfigs((c) => {
        const next = { ...c };
        if (cfg) next[pk] = cfg;
        else delete next[pk];
        return next;
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  if (!active || !value) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <EmptyState
          icon={<CodeIcon className="h-7 w-7" />}
          title="Nothing to install yet"
          description="Create a persona to get its embed snippet."
        />
      </div>
    );
  }

  // Persisting inside the event handler (not an effect) keeps writes tied to real user
  // action and satisfies the set-state-in-effect lint rule. The backend save is what
  // lets a plain src+data-tenant embed (e.g. the clinic site) pick the changes up on
  // its next load; it's debounced so slider drags don't PATCH on every pixel.
  const patch = (p: Partial<WidgetConfig>) => {
    const next = { ...value, ...p };
    try {
      localStorage.setItem(storageKey(active.public_key), JSON.stringify(next));
    } catch {
      /* storage full/blocked — the live config still works for this visit */
    }
    setConfigs((c) => ({ ...c, [active.public_key]: next }));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSync("saving");
    const id = active.id;
    saveTimer.current = setTimeout(() => {
      saveChain.current = saveChain.current.then(async () => {
        try {
          await updatePersona(id, { widget_config: next });
          setSync("saved");
        } catch {
          setSync("error");
        }
      });
    }, 600);
  };

  const reset = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      localStorage.removeItem(storageKey(active.public_key));
    } catch {
      /* ignore */
    }
    setConfigs((c) => {
      const next = { ...c };
      delete next[active.public_key];
      return next;
    });
    // `{}` is the server-side reset; refresh personas so the derived value above
    // doesn't resurrect the old server config from the stale row. Queued on the same
    // chain as saves so an in-flight debounced PATCH can't land after (and undo) it.
    setSync("saving");
    const id = active.id;
    saveChain.current = saveChain.current.then(async () => {
      try {
        await updatePersona(id, { widget_config: {} });
        await refreshPersonas();
        setSync("saved");
      } catch {
        setSync("error");
      }
    });
  };

  return (
    <div className="animate-in mx-auto w-full max-w-6xl px-6 py-8 space-y-8">
      <PageHeader
        title="Install"
        subtitle={
          <>
            Make <span className="text-gradient font-semibold">{active.name}</span> yours — pick a
            look, size and spot, then add it to any website with one tag.
          </>
        }
        action={
          <div className="flex items-center gap-2.5">
            {sync === "saving" && <Badge tone="neutral">Saving…</Badge>}
            {sync === "saved" && (
              <Badge tone="success" className="animate-pop">
                Synced
              </Badge>
            )}
            {sync === "error" && <Badge tone="danger">Sync failed</Badge>}
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshIcon className="h-3.5 w-3.5" />}
              onClick={reset}
            >
              Reset
            </Button>
          </div>
        }
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)]">
        {/* ------------------------------ controls ------------------------------ */}
        <div className="stagger min-w-0 space-y-6">
          {/* Name */}
          <Card className="animate-in p-5">
            <SectionLabel>Assistant name</SectionLabel>
            <p className="mb-3 mt-1 text-[13px] text-[var(--color-faint)]">
              Shown in the chat header. Defaults to the persona’s name.
            </p>
            <TextInput
              value={value.name}
              maxLength={60}
              placeholder={active.name}
              aria-label="Assistant name"
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Card>

          {/* Theme + mode */}
          <Card className="animate-in p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <SectionLabel>Theme</SectionLabel>
                <p className="mt-1 text-[13px] text-[var(--color-faint)]">
                  Every palette works in light or dark — the swatches preview your current mode.
                </p>
              </div>
              <Segmented
                value={value.mode}
                onChange={(mode) => patch({ mode })}
                options={[
                  {
                    value: "light" as ModeId,
                    label: (
                      <span className="flex items-center gap-1.5">
                        <SunIcon className="h-3.5 w-3.5" /> Light
                      </span>
                    ),
                  },
                  {
                    value: "dark" as ModeId,
                    label: (
                      <span className="flex items-center gap-1.5">
                        <MoonIcon className="h-3.5 w-3.5" /> Dark
                      </span>
                    ),
                  },
                ]}
              />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {THEMES.map((t) => (
                <ThemeSwatch
                  key={t.id}
                  theme={t}
                  mode={value.mode}
                  selected={value.theme === t.id}
                  onSelect={() => patch({ theme: t.id })}
                />
              ))}
            </div>
          </Card>

          {/* Size */}
          <Card className="animate-in p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionLabel>Size</SectionLabel>
              <Segmented
                value={value.size}
                onChange={(size) =>
                  size === "custom"
                    ? patch({ size })
                    : patch({ size, width: SIZES[size].w, height: SIZES[size].h })
                }
                options={[
                  ...(Object.keys(SIZES) as (keyof typeof SIZES)[]).map((id) => ({
                    value: id as SizeId,
                    label: SIZES[id].label,
                  })),
                  { value: "custom" as SizeId, label: "Custom" },
                ]}
              />
            </div>
            {value.size === "custom" ? (
              <div className="mt-4 space-y-4">
                <LabeledSlider
                  label="Width"
                  min={MIN_W}
                  max={MAX_W}
                  value={value.width}
                  onChange={(width) => patch({ width })}
                />
                <LabeledSlider
                  label="Height"
                  min={MIN_H}
                  max={MAX_H}
                  value={value.height}
                  onChange={(height) => patch({ height })}
                />
              </div>
            ) : (
              <p className="mt-3 text-[13px] text-[var(--color-faint)]">
                Panel {SIZES[value.size].w} × {SIZES[value.size].h} px · launcher bubble{" "}
                {SIZES[value.size].bubble} px. Pick <span className="font-semibold">Custom</span>{" "}
                for exact dimensions ({MIN_W}–{MAX_W} px wide, {MIN_H}–{MAX_H} px tall).
              </p>
            )}
          </Card>

          {/* Position */}
          <Card className="animate-in p-5">
            <SectionLabel>Position</SectionLabel>
            <p className="mb-4 mt-1 text-[13px] text-[var(--color-faint)]">
              Pick a corner, then fine-tune the exact distance from the edges. The bubble on this
              page moves with it.
            </p>
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
              <CornerPicker
                value={value.position}
                theme={THEMES.find((t) => t.id === value.theme) ?? THEMES[0]}
                onChange={(position) => patch({ position })}
              />
              <div className="min-w-0 flex-1 space-y-4">
                <LabeledSlider
                  label={`From ${value.position.includes("left") ? "left" : "right"} edge`}
                  min={0}
                  max={MAX_OFFSET}
                  value={value.offsetX}
                  onChange={(offsetX) => patch({ offsetX })}
                />
                <LabeledSlider
                  label={`From ${value.position.includes("top") ? "top" : "bottom"} edge`}
                  min={0}
                  max={MAX_OFFSET}
                  value={value.offsetY}
                  onChange={(offsetY) => patch({ offsetY })}
                />
              </div>
            </div>
          </Card>
        </div>

        {/* ------------------------------ output ------------------------------ */}
        <div className="min-w-0 space-y-6 lg:sticky lg:top-8">
          {/* Embed snippet — mac-terminal styled card */}
          <Card className="animate-in overflow-hidden p-0">
            <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2">
              <span className="flex items-center gap-1.5" aria-hidden>
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-danger)] opacity-70" />
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-warning)] opacity-70" />
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-success)] opacity-70" />
              </span>
              <span className="ml-2 font-mono text-[11px] text-[var(--color-faint)]">
                embed.html
              </span>
              <div className="ml-auto">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={
                    copied ? (
                      <CheckIcon className="h-3.5 w-3.5 text-[var(--color-success)]" />
                    ) : (
                      <CopyIcon className="h-3.5 w-3.5" />
                    )
                  }
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(snippet);
                    } catch {
                      return; // clipboard blocked (insecure context) — text stays selectable
                    }
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-relaxed text-[var(--color-text)]">
              <span className="text-[var(--color-faint)]">{"<script"}</span>
              {"\n"}
              {attrs.map(([k, v]) => (
                <span key={k}>
                  {"  "}
                  <span className="text-[var(--color-accent-ink)]">{k}</span>
                  <span className="text-[var(--color-faint)]">=&quot;</span>
                  <span className="text-[var(--color-success)]">{escapeAttr(v)}</span>
                  <span className="text-[var(--color-faint)]">&quot;</span>
                  {"\n"}
                </span>
              ))}
              <span className="text-[var(--color-faint)]">{"></script>"}</span>
            </pre>
          </Card>

          {/* Public key */}
          <Card className="animate-in p-5">
            <div className="flex items-start gap-4">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--accent-wash)] text-[var(--color-accent-ink)]">
                <KeyIcon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  Public key
                </div>
                <div className="mt-1 break-all font-mono text-[14px]">{active.public_key}</div>
                <p className="mt-1.5 text-[12.5px] text-[var(--color-faint)]">
                  Safe to expose — it only lets a visitor chat as this persona; it grants no
                  access to your account or queue.
                </p>
              </div>
            </div>
          </Card>

          {/* Live test callout — gradient border trick */}
          <div className="animate-in rounded-3xl bg-cta p-[1px] glow-accent">
            <div className="rounded-[calc(1.5rem-1px)] bg-[var(--color-surface)] p-5">
              <div className="flex items-center gap-2.5">
                <span className="text-[15px] font-semibold">Test it right here</span>
                <Badge tone="success" pulse>
                  Live
                </Badge>
              </div>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--color-muted)]">
                The chat bubble on this page is{" "}
                <span className="font-semibold text-[var(--color-text)]">
                  {value.name.trim() || active.name}
                </span>{" "}
                wearing your exact settings — theme, size and position update as you tweak them.
                Ask it something only your documents would know. Saved settings apply anywhere
                the tag is embedded: a plain tag (like your website&apos;s) picks them up on its
                next page load, while any <code className="font-mono text-[12px]">data-*</code>{" "}
                attribute written into a snippet stays pinned to that value.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Local controls ------------------------------------------------------------------- */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode }[];
}) {
  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-soft)] p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
            value === o.value
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

function ThemeSwatch({
  theme,
  mode,
  selected,
  onSelect,
}: {
  theme: (typeof THEMES)[number];
  mode: ModeId;
  selected: boolean;
  onSelect: () => void;
}) {
  const surface = MODE_SURFACES[mode];
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`group overflow-hidden rounded-2xl border text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
        selected
          ? "border-[var(--color-accent)] ring-2 ring-[var(--ring)] glow-accent"
          : "border-[var(--color-border)] hover:-translate-y-0.5 hover:border-[var(--color-border-strong)]"
      }`}
    >
      {/* mini widget: header gradient + two message bubbles on the mode's surfaces */}
      <div
        className="flex h-8 items-center gap-1.5 px-2.5"
        style={{ background: `linear-gradient(135deg, ${theme.a}, ${theme.b})` }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-white/80" />
        <span className="h-1.5 w-10 rounded-full bg-white/70" />
      </div>
      <div className="space-y-1.5 px-2.5 py-2.5" style={{ background: surface.logBg }}>
        <div
          className="h-2.5 w-3/5 rounded-full border"
          style={{ background: surface.aiBg, borderColor: surface.aiBorder }}
        />
        <div className="ml-auto h-2.5 w-2/5 rounded-full" style={{ background: theme.deep }} />
      </div>
      <div className="flex items-center justify-between bg-[var(--color-surface)] px-2.5 py-2">
        <span className="text-[12px] font-semibold">{theme.label}</span>
        {selected && <CheckIcon className="h-3.5 w-3.5 text-[var(--color-accent-ink)]" />}
      </div>
    </button>
  );
}

function LabeledSlider({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-[var(--color-muted)]">{label}</span>
        <span className="font-mono text-[12.5px] text-[var(--color-text)]">{value}px</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value))))}
        className="w-full cursor-pointer"
        style={{ accentColor: "var(--color-accent)" }}
      />
      <div className="mt-0.5 flex justify-between text-[11px] text-[var(--color-faint)]">
        <span>{min}px</span>
        <span>{max}px</span>
      </div>
    </div>
  );
}

function CornerPicker({
  value,
  theme,
  onChange,
}: {
  value: PositionId;
  theme: (typeof THEMES)[number];
  onChange: (v: PositionId) => void;
}) {
  const spot: Record<PositionId, string> = {
    "top-left": "left-2 top-8",
    "top-right": "right-2 top-8",
    "bottom-left": "bottom-2 left-2",
    "bottom-right": "bottom-2 right-2",
  };
  return (
    <div className="relative aspect-[16/11] w-full shrink-0 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-soft)] sm:w-56">
      {/* mini browser chrome */}
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-border-strong)]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-border-strong)]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-border-strong)]" />
        <span className="ml-1.5 h-2 w-16 rounded-full bg-[var(--color-bg-soft)]" />
      </div>
      {POSITIONS.map((p) => {
        const selected = p.id === value;
        return (
          <button
            key={p.id}
            type="button"
            aria-label={p.label}
            aria-pressed={selected}
            onClick={() => onChange(p.id)}
            className={`absolute grid h-8 w-8 place-items-center rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${spot[p.id]} ${
              selected
                ? "text-white shadow-lg"
                : "border-2 border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)]/60 hover:border-[var(--color-accent)]"
            }`}
            style={
              selected
                ? { background: `linear-gradient(135deg, ${theme.a}, ${theme.b})` }
                : undefined
            }
          >
            {selected && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 20.5l1.5-5.2A8.5 8.5 0 1 1 21 11.5z"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}
