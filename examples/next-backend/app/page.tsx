/**
 * A tiny index page listing the mounted endpoints. This example is a backend
 * (MVP §10) — there is deliberately no chat UI; drive it with curl or fetch.
 */
export default function Home() {
  return (
    <main>
      <h1>Chatpack is mounted at /api/chat</h1>
      <p>
        This example is a <strong>backend</strong> — no UI. Try it with curl (auth here is a demo{" "}
        <code>x-user-id</code> header):
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
