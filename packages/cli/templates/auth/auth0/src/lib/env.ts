function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example, fill in the real value, then restart.`,
    );
  }
  return value;
}

// The Auth0 SDK reads these from process.env itself, so without this check a
// missing value surfaces as an opaque failure on the first sign-in request
// instead of a clear error at startup.
export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  AUTH0_DOMAIN: required("AUTH0_DOMAIN"),
  AUTH0_CLIENT_ID: required("AUTH0_CLIENT_ID"),
  AUTH0_CLIENT_SECRET: required("AUTH0_CLIENT_SECRET"),
  AUTH0_SECRET: required("AUTH0_SECRET"),
  APP_BASE_URL: required("APP_BASE_URL"),
};
