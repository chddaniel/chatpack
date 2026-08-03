import { defineConfig } from "vitest/config";

/**
 * The only package that needs a vitest config: every test here boots its own
 * PGlite instance (Postgres compiled to WASM) in a `beforeEach`, which is far
 * slower than an ordinary hook. On a busy machine - `turbo test` running this
 * suite alongside seven other packages - that setup can exceed vitest's default
 * 10s hook timeout and fail a test that has nothing wrong with it.
 *
 * The timeouts below are generous on purpose: they cost nothing when things are
 * fast, and they stop a green suite from going red because the CPU was busy.
 */
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
