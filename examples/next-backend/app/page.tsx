import type { ReactElement } from "react";

/**
 * A tiny index page linking to the client example and mounted endpoints.
 */
export default function Home(): ReactElement {
  return (
    <main>
      <h1>Chatpack is mounted at /api/chat</h1>
      <p>
        Open the <a href="/chat">React client example</a>, or use curl with the demo{" "}
        <code>x-user-id</code> header:
      </p>
      <pre>{`# find-or-create a conversation
curl -s -X POST http://localhost:3000/api/chat/conversations \\
  -H 'x-user-id: alice' -H 'content-type: application/json' \\
  -d '{"otherUserId":"bob"}'

# stream live events (SSE)
curl -N http://localhost:3000/api/chat/stream -H 'x-user-id: bob'`}</pre>
      <p>
        Full route table:{" "}
        <a href="https://github.com/chddaniel/chatpack#readme">github.com/chddaniel/chatpack</a>
      </p>
    </main>
  );
}
