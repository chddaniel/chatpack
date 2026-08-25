"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Palette, Sun } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

const COLOR_SCHEME_STORAGE_KEY = "chatpack-color-scheme";

const COLOR_SCHEMES = [
  { value: "default", label: "Default", swatch: "bg-neutral-500" },
  { value: "ocean", label: "Ocean", swatch: "bg-sky-500" },
  { value: "sunset", label: "Sunset", swatch: "bg-orange-500" },
  { value: "forest", label: "Forest", swatch: "bg-emerald-600" },
  { value: "violet", label: "Violet", swatch: "bg-violet-500" },
] as const;

type ColorScheme = (typeof COLOR_SCHEMES)[number]["value"];

function isColorScheme(value: string | null): value is ColorScheme {
  return COLOR_SCHEMES.some((scheme) => scheme.value === value);
}

function applyColorScheme(colorScheme: ColorScheme): void {
  document.documentElement.dataset.colorScheme = colorScheme;
  window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, colorScheme);
}

function storedColorScheme(): ColorScheme {
  if (typeof window === "undefined") return "default";
  const stored = window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
  return isColorScheme(stored) ? stored : "default";
}

export function ThemeSelector() {
  const { setTheme, theme } = useTheme();
  const [colorScheme, setColorScheme] = useState<ColorScheme>(storedColorScheme);

  useEffect(() => {
    applyColorScheme(colorScheme);
  }, [colorScheme]);

  function handleColorSchemeChange(value: string): void {
    if (!isColorScheme(value)) return;
    setColorScheme(value);
    applyColorScheme(value);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="outline" aria-label="Customize theme">
          <Palette />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="system">
            <Monitor />
            System
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">
            <Sun />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon />
            Dark
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Color scheme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={colorScheme} onValueChange={handleColorSchemeChange}>
          {COLOR_SCHEMES.map((scheme) => (
            <DropdownMenuRadioItem key={scheme.value} value={scheme.value}>
              <span className={`size-3 rounded-full ${scheme.swatch}`} aria-hidden="true" />
              {scheme.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
