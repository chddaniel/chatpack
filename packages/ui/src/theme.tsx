import type { CSSProperties, ReactNode } from "react";

/** CSS values that define the visual language of Chatpack UI blocks. */
export interface ChatpackUITheme {
  surface?: string;
  panel?: string;
  border?: string;
  text?: string;
  muted?: string;
  accent?: string;
  accentContrast?: string;
  bubbleOther?: string;
  radius?: string;
}

/** Props for {@link ChatpackUIThemeProvider}. */
export interface ChatpackUIThemeProviderProps {
  /** Values that override the package defaults. */
  theme: ChatpackUITheme;
  /** Themed UI subtree. */
  children: ReactNode;
}

/** Applies Chatpack UI theme tokens without requiring a Tailwind setup. */
export function ChatpackUIThemeProvider({ theme, children }: ChatpackUIThemeProviderProps) {
  const style = Object.fromEntries(
    Object.entries(theme).map(([key, value]) => [
      `--chatpack-ui-${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
      value,
    ]),
  ) as CSSProperties;
  return <div style={style}>{children}</div>;
}
