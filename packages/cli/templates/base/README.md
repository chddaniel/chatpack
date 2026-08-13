# {{PACKAGE_NAME}}

A production-oriented Chatpack {{FRAMEWORK}} starter with Neon Postgres, Drizzle, and {{AUTH_PROVIDER}} authentication.

## Set up

1. Create a Neon database.
2. Copy `.env.example` to `.env.local` for Next.js or `.env` for Hono/Express.
3. Add the required secrets described in the environment example.
4. Run `npm run db:generate`, `npm run db:migrate`, and `npm run setup:check`.
5. Run `npm run dev`.

The generated source is application-owned. Edit it to fit your product. It is not a reusable `@chatpack/ui` package.

## Deploy to Vercel

Import the repository in Vercel, add the same environment variables, and deploy. The Neon Pool is registered with the Vercel Functions lifecycle helper. Chatpack uses transactions for message ordering, so do not replace it with the Neon HTTP driver.

Generation does not create external accounts, write secrets, run migrations, or deploy this app.
