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
