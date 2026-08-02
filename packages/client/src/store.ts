/** Small external-store primitives used by the client cache and React hooks. */

/** Read-only interface for subscribing to state changes. */
export interface ReadonlyStore<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/** Mutable external store interface. */
export interface Store<T> extends ReadonlyStore<T> {
  set(value: T): void;
  update(updater: (value: T) => T): void;
}

/** Create a per-instance mutable store with synchronous updates. */
export function createStore<T>(initialValue: T): Store<T> {
  let value = initialValue;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => value,
    set(nextValue) {
      if (Object.is(value, nextValue)) return;
      value = nextValue;
      for (const listener of listeners) listener();
    },
    update(updater) {
      const nextValue = updater(value);
      if (Object.is(value, nextValue)) return;
      value = nextValue;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
