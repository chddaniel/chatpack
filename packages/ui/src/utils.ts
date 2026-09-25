import type { ReactNode } from "react";

/** Joins optional class names without introducing a runtime dependency. */
export function cx(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

/** Host-owned renderer for Chatpack's opaque user ids. */
export type RenderUser = (userId: string) => ReactNode;

export function defaultRenderUser(userId: string): ReactNode {
  return userId;
}
