"use client";

import { useState } from "react";
import { MoonIcon, SunIcon } from "./icons";

type Theme = "light" | "dark";
const KEY = "replyo:theme";

/* The inline script in layout.tsx has already stamped a concrete data-theme on <html>
   before paint, so the lazy initializer always agrees with the DOM. */
function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** Theme switch in the product's own language: token track, brand-gradient knob (the
 *  same bg-cta as buttons and the logo tile) with the sun/moon morphing inside it. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode — the choice just won't persist */
    }
  }

  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={dark}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className={`relative inline-flex h-7 w-[52px] shrink-0 items-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-bg-soft)] transition-all duration-300 hover:border-[var(--color-accent)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] ${className}`}
    >
      {/* resting-state hints; the knob covers whichever side is active */}
      <SunIcon aria-hidden className="absolute left-[7px] h-3 w-3 text-[var(--color-faint)]" />
      <MoonIcon aria-hidden className="absolute right-[7px] h-3 w-3 text-[var(--color-faint)]" />

      {/* knob — brand gradient, springy glide, icon morphs sun <-> moon */}
      <span
        aria-hidden
        className={`relative z-10 grid h-[22px] w-[22px] place-items-center rounded-full bg-cta text-white glow-accent transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
          dark ? "translate-x-[25px]" : "translate-x-[3px]"
        }`}
      >
        <SunIcon
          className={`absolute h-3 w-3 transition-all duration-300 ${
            dark ? "-rotate-90 scale-0 opacity-0" : "rotate-0 scale-100 opacity-100"
          }`}
        />
        <MoonIcon
          className={`absolute h-3 w-3 transition-all duration-300 ${
            dark ? "rotate-0 scale-100 opacity-100" : "rotate-90 scale-0 opacity-0"
          }`}
        />
      </span>
    </button>
  );
}
