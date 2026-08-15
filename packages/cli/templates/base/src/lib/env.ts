/**
 * The module that validates the environment is also the module that loads it.
 *
 * Nothing reads a `.env` file on its own here: `node` does not, `tsx` does not,
 * and `scripts/` only get theirs by calling dotenv themselves. Next.js is the
 * exception - `next dev` and `next build` load `.env*` before any application
 * code, which is why its own `src/lib/env.ts` (one per auth provider) has no
 * copy of this. Without it a backend starter throws
 * `Missing required environment variable` while the file the README told you to
 * create sits in the project root.
 *
 * Order matches `scripts/`: `.env.local` first - skipped under
 * `NODE_ENV=production` so a stale local file cannot shadow a deployed one -
 * then `.env`. Real environment variables always win over both, so a platform
 * that injects them is unaffected, and a file that is not there is simply
 * nothing to read.
 */
for (const file of process.env.NODE_ENV === "production" ? [".env"] : [".env.local", ".env"]) {
  try {
    // Guarded rather than called: added in Node 20.12, and absent on runtimes
    // that have no filesystem to read (Vercel Edge, Cloudflare Workers), both of
    // which supply their variables directly anyway.
    if (typeof process.loadEnvFile === "function") process.loadEnvFile(file);
  } catch {
    // The file does not exist. Only the variables below are actually required,
    // and the check for them says far more than an ENOENT would.
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example, fill in the real value, then restart.`,
    );
  }
  return value;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
};
