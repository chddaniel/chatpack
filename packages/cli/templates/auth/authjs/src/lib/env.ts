function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example, fill in the real value, then restart.`,
    );
  }
  return value;
}

// Auth.js reads these from process.env itself, so without this check a missing
// value surfaces as an opaque failure on the first sign-in request instead of a
// clear error at startup.
export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  AUTH_SECRET: required("AUTH_SECRET"),
  AUTH_GITHUB_ID: required("AUTH_GITHUB_ID"),
  AUTH_GITHUB_SECRET: required("AUTH_GITHUB_SECRET"),
};
