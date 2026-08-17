function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example, fill in the real value, then restart.`,
    );
  }
  return value;
}

// Better Auth reads its secret from process.env itself, so without this check a
// missing value surfaces as an opaque failure on the first sign-in request
// instead of a clear error at startup. BETTER_AUTH_URL is deliberately not
// required: Better Auth infers the base URL from the request when it is absent,
// and hard-failing would break deployments that rely on that.
export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
};
