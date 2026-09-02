"use client";

import { useEffect, type ReactNode } from "react";
import type { ThemeProviderProps } from "next-themes";
import { ThemeProvider as NextThemesProvider } from "next-themes";

export const COLOR_SCHEME_STORAGE_KEY = "chatpack-color-scheme";
/** Temporary rollout gate for alternate color schemes. */
export const ENABLE_COLOR_SCHEMES = false;

const COLOR_SCHEME_VALUES = ["default", "ocean", "sunset", "forest", "violet"] as const;

export type ColorScheme = (typeof COLOR_SCHEME_VALUES)[number];

export function isColorScheme(value: string | null): value is ColorScheme {
  return value !== null && COLOR_SCHEME_VALUES.includes(value as ColorScheme);
}

export function applyColorScheme(colorScheme: ColorScheme): void {
  if (!ENABLE_COLOR_SCHEMES) {
    document.documentElement.dataset.colorScheme = "default";
    window.localStorage.removeItem(COLOR_SCHEME_STORAGE_KEY);
    return;
  }
  document.documentElement.dataset.colorScheme = colorScheme;
  window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, colorScheme);
}

export function storedColorScheme(): ColorScheme {
  if (!ENABLE_COLOR_SCHEMES) return "default";
  if (typeof window === "undefined") return "default";
  const stored = window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
  return isColorScheme(stored) ? stored : "default";
}

function ColorSchemeSync({ children }: { children: ReactNode }) {
  useEffect(() => {
    applyColorScheme(storedColorScheme());
  }, []);
  return children;
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      <ColorSchemeSync>{children}</ColorSchemeSync>
    </NextThemesProvider>
  );
}
