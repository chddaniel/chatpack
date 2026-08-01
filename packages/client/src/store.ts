export interface ReadonlyStore<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export interface Store<T> extends ReadonlyStore<T> {
  set(value: T): void;
  update(updater: (value: T) => T): void;
}

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
