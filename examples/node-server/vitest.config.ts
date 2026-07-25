import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Smoke tests hit a real (possibly remote) Postgres — allow for network latency.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // One server process at a time: backends share the module-level BASE/server.
    fileParallelism: false,
  },
});
