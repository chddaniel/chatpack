/** React bindings for the client's platform external stores. */
import { useSyncExternalStore } from "react";
import type { ReadonlyStore } from "../store";

const emptySubscribe = (): (() => void) => () => undefined;

/** Reads an observable store with React's external-store subscription API. */
export function useExternalStore<T>(store: ReadonlyStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Reads an optional plugin store and returns a fallback when it is absent. */
export function useOptionalExternalStore<T>(
  store: ReadonlyStore<unknown> | null,
  fallback: T,
): unknown {
  const getSnapshot = store?.getSnapshot ?? (() => fallback);
  return useSyncExternalStore(store?.subscribe ?? emptySubscribe, getSnapshot, getSnapshot);
}
