# @chatpack/ui

Reusable React UI blocks for Chatpack. The package is intentionally unaware of
authentication, profiles, routing, and database setup. The host application
provides the React client, viewer id, and user renderer.

```sh
pnpm add @chatpack/ui @chatpack/client
```

Import the package stylesheet once, then provide a React-enabled Chatpack
client:

```tsx
import { createChatClient } from "@chatpack/client/react";
import { ChatpackUIProvider, ChatWindow } from "@chatpack/ui";
import "@chatpack/ui/styles.css";

const client = createChatClient({ baseURL: "/api", basePath: "/api/chat" });

export function Chat() {
  return (
    <ChatpackUIProvider client={client} userId="alice">
      <ChatWindow conversationId="conversation-id" />
    </ChatpackUIProvider>
  );
}
```

The initial release includes the provider, primitives, conversation list,
message thread, composer, connection status, and chat window. More gallery
blocks will be added without changing the client contract.
