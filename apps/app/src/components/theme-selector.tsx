"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Palette, Sun } from "lucide-react";

import {
  ENABLE_COLOR_SCHEMES,
  applyColorScheme,
  isColorScheme,
  storedColorScheme,
  type ColorScheme,
} from "@/components/theme-provider";
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

const COLOR_SCHEMES = [
  { value: "default", label: "Default", swatch: "bg-brand" },
  { value: "ocean", label: "Ocean", swatch: "bg-sky-500" },
  { value: "sunset", label: "Sunset", swatch: "bg-orange-500" },
  { value: "forest", label: "Forest", swatch: "bg-emerald-600" },
  { value: "violet", label: "Violet", swatch: "bg-violet-500" },
] as const;

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
        {ENABLE_COLOR_SCHEMES && (
          <>
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
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
