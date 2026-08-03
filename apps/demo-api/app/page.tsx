/**
 * The landing page IS the documentation for this backend.
 *
 * Vibe coders (and the AI builders they drive) land here first, so everything
 * needed to connect lives on this one page - no cross-referencing.
 */

const code: React.CSSProperties = {
  background: "#f4f4f5",
  border: "1px solid #e4e4e7",
  borderRadius: "0.5rem",
  padding: "0.875rem 1rem",
  overflowX: "auto",
  fontSize: "0.8125rem",
  lineHeight: 1.55,
};

const inline: React.CSSProperties = {
  background: "#f4f4f5",
  borderRadius: "0.25rem",
  padding: "0.1rem 0.35rem",
  fontSize: "0.875em",
};

export default function Home() {
  return (
    <main>
      <h1 style={{ marginBottom: "0.25rem" }}>Chatpack demo backend</h1>
      <p style={{ color: "#52525b", marginTop: 0 }}>
        A real, running Chatpack server you can point chat UI at — no signup, no install, no local
        setup. Built for people designing chat components in Lovable, v0, Shipper, or Bolt.
      </p>

      <h2>Paste this into your app</h2>
      <p>
        Pick any <strong>sandbox</strong> name (your project name works) and any{" "}
        <strong>demo user</strong> — <code style={inline}>alice</code>,{" "}
        <code style={inline}>bob</code>, and <code style={inline}>carol</code> already have
        conversations waiting.
      </p>
      <pre style={code}>{`import { createChatClient } from "@chatpack/client/react";
import { typingClient, presenceClient, receiptsClient } from "@chatpack/client/plugins";

export const chatClient = createChatClient({
  baseURL: "https://demo-api.chatpack.dev",
  basePath: "/api/chat/u/my-sandbox/alice",   // <-- sandbox + who you are
  plugins: [typingClient(), presenceClient(), receiptsClient()],
});

export const currentUserId = "alice";`}</pre>

      <h2>Why the identity is in the URL</h2>
      <p>
        AI-builder previews run inside a cross-site iframe, where browsers block third-party
        cookies. A cookie-based demo login silently fails there. Putting the demo user in the path
        means no cookies, no CORS credentials, and a working <code style={inline}>EventSource</code>{" "}
        for live updates.
      </p>
      <p style={{ color: "#52525b" }}>
        This is a demo-only shortcut: anyone with the URL can act as that user. Real apps resolve a
        session in Chatpack&rsquo;s <code style={inline}>auth</code> hook instead.
      </p>

      <h2>What&rsquo;s already in a fresh sandbox</h2>
      <ul>
        <li>
          <strong>alice ↔ bob</strong> — a short conversation, including one edited message and one
          deleted message (a tombstone) so you can style those states.
        </li>
        <li>
          <strong>alice ↔ carol</strong> — a second conversation, so list components have more than
          one row.
        </li>
      </ul>

      <h2>Two windows = live chat</h2>
      <p>
        Open your preview twice: one with <code style={inline}>.../alice</code>, one with{" "}
        <code style={inline}>.../bob</code>, same sandbox. Messages, typing indicators, and presence
        flow between them in real time.
      </p>

      <h2>Try it without any code</h2>
      <pre
        style={code}
      >{`curl https://demo-api.chatpack.dev/api/chat/u/demo/alice/conversations`}</pre>

      <h2>Rules of the road</h2>
      <ul>
        <li>Messages are capped at 2000 characters.</li>
        <li>
          Storage is in-memory: data resets when the server goes cold. Fresh seed data is planted
          automatically, so a reset never leaves you with an empty screen.
        </li>
        <li>Sandboxes are isolated but public — treat everything here as throwaway.</li>
      </ul>

      <p style={{ marginTop: "2rem", color: "#52525b", fontSize: "0.9375rem" }}>
        Full API reference: <a href="https://docs.chatpack.dev">docs.chatpack.dev</a> ·{" "}
        <a href="https://github.com/chddaniel/chatpack">GitHub</a>
      </p>
    </main>
  );
}
