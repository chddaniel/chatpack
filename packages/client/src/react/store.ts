import { useSyncExternalStore } from "react";
import type { ReadonlyStore } from "../store";

const emptySubscribe = (): (() => void) => () => undefined;

export function useExternalStore<T>(store: ReadonlyStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useOptionalExternalStore<T>(
  store: ReadonlyStore<unknown> | null,
  fallback: T,
): unknown {
  const getSnapshot = store?.getSnapshot ?? (() => fallback);
  return useSyncExternalStore(store?.subscribe ?? emptySubscribe, getSnapshot, getSnapshot);
}
