"use client";

import { useState } from "react";
import { createChatClient } from "@chatpack/client/react";

const chatClient = createChatClient();

function signInAs(userId: string): void {
  // SameSite=Lax works because this page is same-origin with the handler and
  // served over plain-http localhost (where `Secure` cookies fail in some
  // browsers). Inside a cross-site iframe preview (Lovable, v0, ...) use the
  // iframe-proof recipe from llms.txt: SameSite=None; Secure; Partitioned.
  document.cookie = `demo_user=${encodeURIComponent(userId)}; Path=/; Max-Age=86400; SameSite=Lax`;
  window.location.reload();
}

export default function ChatPage() {
  const [currentUserId, setCurrentUserId] = useState("alice");
  const [otherUserId, setOtherUserId] = useState("bob");
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [body, setBody] = useState("");
  const conversations = chatClient.useConversations();
  const conversationId = selectedConversationId || conversations.data?.conversations[0]?.id || "";
  const messages = chatClient.useMessages({ conversationId, limit: 50 });
  chatClient.useRealtimeStatus();

  async function createConversation(): Promise<void> {
    const result = await chatClient.conversations.create({ otherUserId });
    if (result.error === null) setSelectedConversationId(result.data.id);
  }

  function signInAsUser(userId: string): void {
    signInAs(userId);
    setCurrentUserId(userId);
  }

  async function sendMessage(): Promise<void> {
    if (conversationId === "" || body.trim() === "") return;
    const result = await chatClient.messages.send({ conversationId, body });
    if (result.error === null) setBody("");
  }

  return (
    <main>
      <h1>Chatpack client example</h1>
      <p>Demo identity: {currentUserId}</p>
      <button onClick={() => signInAsUser("alice")}>Sign in as alice</button>{" "}
      <button onClick={() => signInAsUser("bob")}>Sign in as bob</button>
      <section>
        <h2>New conversation</h2>
        <input value={otherUserId} onChange={(event) => setOtherUserId(event.target.value)} />{" "}
        <button onClick={() => void createConversation()}>Open</button>
      </section>
      <section>
        <h2>Conversations</h2>
        <ul>
          {conversations.data?.conversations.map((conversation) => (
            <li key={conversation.id}>
              <button onClick={() => setSelectedConversationId(conversation.id)}>
                {conversation.id}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Messages</h2>
        <ul>
          {messages.data?.messages.map((message) => (
            <li key={message.id}>{message.body}</li>
          ))}
        </ul>
        <input value={body} onChange={(event) => setBody(event.target.value)} />{" "}
        <button onClick={() => void sendMessage()}>Send</button>
      </section>
    </main>
  );
}
