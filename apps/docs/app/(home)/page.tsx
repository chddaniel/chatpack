import Link from "next/link";
import { gitConfig } from "@/lib/shared";

const features = [
  {
    title: "Bring your own auth",
    body: "One auth hook - your session in, a user id out. Chatpack never owns a users table.",
  },
  {
    title: "One handler, every route",
    body: "A single Web-standard handler serves conversations, messages, read-state, and the live stream.",
  },
  {
    title: "DMs and group chats",
    body: "The same conversation shape either way - groups add members, admin roles, and rename, up to 256 people.",
  },
  {
    title: "Real-time built in",
    body: "One EventSource. Automatic reconnection and missed-message backfill - no WebSocket server.",
  },
  {
    title: "Adapter-driven storage",
    body: "In-memory for demos, Drizzle/Postgres for production, or implement the adapter for any database.",
  },
  {
    title: "Typing, presence, read ticks",
    body: 'The "feels alive" features ship as opt-in plugins inside core - no extra install.',
  },
  {
    title: "AI-ready by design",
    body: "An AI assistant is just another participant. llms.txt ships in every npm package.",
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-col flex-1">
      <section className="flex flex-col items-center text-center px-6 pt-24 pb-16">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight max-w-3xl">
          Open-source chat infrastructure for developers
        </h1>
        <p className="mt-6 text-lg text-fd-muted-foreground max-w-2xl">
          Install a package, wire up your database and auth, and get a production-ready chat backend
          - 1:1 and group conversations, messages, permissions, read-state, and real-time delivery -
          without rebuilding it from scratch.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="rounded-full bg-fd-primary px-6 py-2.5 font-medium text-fd-primary-foreground hover:opacity-90 transition-opacity"
          >
            Get started
          </Link>
          <a
            href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
            rel="noreferrer noopener"
            className="rounded-full border px-6 py-2.5 font-medium hover:bg-fd-accent transition-colors"
          >
            GitHub
          </a>
        </div>
        <code className="mt-8 rounded-lg border bg-fd-secondary px-4 py-2 text-sm text-fd-secondary-foreground">
          npm install @chatpack/core @chatpack/adapter-memory
        </code>
      </section>

      <section className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4 px-6 pb-24 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <div key={feature.title} className="rounded-xl border bg-fd-card p-5 text-left">
            <h2 className="font-semibold">{feature.title}</h2>
            <p className="mt-2 text-sm text-fd-muted-foreground">{feature.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
