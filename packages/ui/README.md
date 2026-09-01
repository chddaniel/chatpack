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

The package exports the complete 76-block gallery: layouts, inputs, realtime
indicators, groups, moderation, media, and presentational primitives. Connected
blocks call typed `@chatpack/client` actions. The host still owns auth, profile
rendering, routing, and database policy.

Group and moderation blocks take conversation or target ids and load their data
from the client. They do not accept caller-provided records that can drift from
Chatpack state. Media blocks accept Filepack references and an authorized
resolver from `@chatpack/file`; attachment metadata never contains a URL.

Import `@chatpack/ui/styles.css` once. Its light and dark defaults use the
Chatpack brand theme. Use `ChatpackUIThemeProvider` for token overrides,
including separate `input`, `bubbleOwn`, `bubbleOwnMuted`, `bubbleOwnContrast`,
`destructive`, `online`, and `mentionRing` values. Use `renderUser` wherever a block displays
an opaque user id.
