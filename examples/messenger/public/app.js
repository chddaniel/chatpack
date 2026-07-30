/**
 * The entire messenger frontend, in plain JavaScript. No framework, no build
 * step, no Chatpack client library - just fetch() + EventSource against the
 * REST + SSE API that `chat.handler()` serves.
 *
 * Sections mirror the tutorial in this example's README:
 *   1. auth        - who am I? (your app's concern, not Chatpack's)
 *   2. api()       - tiny fetch wrapper for Chatpack's JSON envelopes/errors
 *   3. inbox       - GET  /conversations
 *   4. new chat    - POST /conversations           (find-or-create)
 *   5. open thread - GET  /conversations/:id/messages (+ scroll-back cursor)
 *   6. send        - POST /conversations/:id/messages
 *   7. edit/delete - PATCH/DELETE /messages/:id
 *   8. read state  - POST /conversations/:id/read
 *   9. realtime    - GET  /stream via EventSource
 *  10. plugins     - typing, presence, ✓/✓✓ ticks (ephemeral events)
 */

const BASE = "/api/chat";

// --- state -----------------------------------------------------------------
let me = null; //           { id }
let conversations = []; //  Conversation[] (sidebar order)
let current = null; //      the open Conversation, or null
let messages = []; //       messages of `current`, oldest -> newest
let olderCursor = null; //  nextCursor for scroll-back, or null when exhausted
const unread = new Set(); // conversation ids with unseen messages
let stream = null; //       EventSource
// Plugin state - all ephemeral, so all of it lives client-side:
const presenceByUser = new Map(); // userId -> { online, lastSeenAt }
const deliveredSeq = new Map(); //  conversationId -> highest seq confirmed ✓✓
let typingHideTimer = null; //      clears "is typing…" when pings stop
let lastTypingSentAt = 0; //        throttle for our own typing POSTs

const $ = (id) => document.getElementById(id);

// --- 1. auth (demo) ----------------------------------------------------------
// Chatpack never sees these routes - it only cares that its own requests
// carry the session cookie, which the browser attaches automatically.

async function whoAmI() {
  const res = await fetch("/auth/me");
  return res.ok ? res.json() : null;
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: $("login-username").value.trim() }),
  });
  const data = await res.json();
  if (!res.ok) {
    $("login-error").textContent = data.error;
    return;
  }
  me = data;
  enterApp();
});

$("logout").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.reload();
});

// --- 2. a 12-line Chatpack API client ---------------------------------------
// Every response is a JSON envelope keyed by resource ({ conversation },
// { messages, nextCursor }, ...). Errors are { error: { code, message } }.

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: options.body ? { "content-type": "application/json" } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error.message), { code: data.error.code });
  return data;
}

// --- 3. inbox: list my conversations ----------------------------------------

function otherUser(conversation) {
  const other = conversation.participants.find((p) => p.userId !== me.id);
  return other ? other.userId : me.id; // self-chat fallback
}

async function loadConversations() {
  ({ conversations } = await api("/conversations"));
  renderSidebar();
}

function renderSidebar() {
  const list = $("conversations");
  list.innerHTML = "";
  for (const conversation of conversations) {
    const li = document.createElement("li");
    li.classList.toggle("active", current?.id === conversation.id);
    const other = otherUser(conversation);
    const presence = document.createElement("span");
    presence.className = "presence-dot" + (presenceByUser.get(other)?.online ? " online" : "");
    li.appendChild(presence);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = other;
    li.appendChild(name);
    if (unread.has(conversation.id)) {
      const dot = document.createElement("span");
      dot.className = "dot";
      li.appendChild(dot);
    }
    li.addEventListener("click", () => openConversation(conversation.id));
    list.appendChild(li);
  }
}

// --- 4. start a chat: find-or-create by user pair ----------------------------
// POST /conversations is idempotent per pair - "chatting again" with the same
// user returns the existing conversation instead of creating a duplicate.

$("new-chat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const otherUserId = $("new-chat-user").value.trim();
  if (!otherUserId) return;
  const { conversation } = await api("/conversations", {
    method: "POST",
    body: { otherUserId },
  });
  $("new-chat-user").value = "";
  if (!conversations.some((c) => c.id === conversation.id)) {
    conversations.unshift(conversation);
  }
  openConversation(conversation.id);
});

// --- 5. open a thread: load history ------------------------------------------
// GET .../messages returns NEWEST first with a cursor for older pages, so we
// reverse each page for a chronological render and keep `nextCursor` around
// for the "Load older" button.

async function openConversation(conversationId) {
  ({ conversation: current } = await api(`/conversations/${conversationId}`));
  const page = await api(`/conversations/${conversationId}/messages?limit=30`);
  messages = page.messages.slice().reverse();
  olderCursor = page.nextCursor;
  unread.delete(conversationId);
  hideTyping();

  $("empty-state").classList.add("hidden");
  $("thread").classList.remove("hidden");
  $("thread-name").textContent = otherUser(current);
  renderThreadStatus();
  renderSidebar();
  renderMessages();
  scrollToBottom();
  markRead();
  refreshPresence();
}

$("load-older").addEventListener("click", async () => {
  const container = $("messages");
  const heightBefore = container.scrollHeight;
  const page = await api(
    `/conversations/${current.id}/messages?limit=30&cursor=${encodeURIComponent(olderCursor)}`,
  );
  messages = page.messages.slice().reverse().concat(messages);
  olderCursor = page.nextCursor;
  renderMessages();
  container.scrollTop = container.scrollHeight - heightBefore; // keep position
});

// --- 6. send a message --------------------------------------------------------
// We don't append locally on success - our own message comes back through the
// SSE stream like everyone else's, so there's exactly one code path.

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = $("composer-input").value.trim();
  if (!body || !current) return;
  $("composer-input").value = "";
  // Clear our typing indicator on the other side eagerly.
  lastTypingSentAt = 0;
  api(`/conversations/${current.id}/typing`, {
    method: "POST",
    body: { isTyping: false },
  }).catch(() => {});
  await api(`/conversations/${current.id}/messages`, { method: "POST", body: { body } });
});

// --- 7. edit / soft-delete my own messages -------------------------------------

async function editMessage(message) {
  const body = prompt("Edit message:", message.body);
  if (body === null || body.trim() === "") return;
  await api(`/messages/${message.id}`, { method: "PATCH", body: { body } });
  // the update arrives via the `message.updated` SSE event
}

async function deleteMessage(message) {
  if (!confirm("Delete this message?")) return;
  await api(`/messages/${message.id}`, { method: "DELETE" });
  // the soft-delete arrives via the `message.deleted` SSE event
}

// --- 8. durable read-state ------------------------------------------------------
// markRead persists "I've read up to message X" server-side. The other side's
// read-state is on their Participant entry (`lastReadMessageId`), which we get
// whenever we (re)fetch the conversation - that's what the "Seen" label uses.
// (The receipts() plugin also pushes a live `receipt.read` ping - see §10 -
// so the label updates instantly while both sides are online.)

async function markRead() {
  const last = messages[messages.length - 1];
  if (!last || !current) return;
  await api(`/conversations/${current.id}/read`, {
    method: "POST",
    body: { messageId: last.id },
  });
}

function lastSeenMessageId() {
  const other = current.participants.find((p) => p.userId !== me.id);
  if (!other?.lastReadMessageId) return null;
  // "Seen" applies to my latest message at or before their read marker.
  const readIndex = messages.findIndex((m) => m.id === other.lastReadMessageId);
  if (readIndex === -1) return null;
  for (let i = readIndex; i >= 0; i--) {
    if (messages[i].senderId === me.id) return messages[i].id;
  }
  return null;
}

// --- 9. realtime: one EventSource for everything ---------------------------------
// The stream carries events for ALL my conversations. Reconnects and missed-
// message backfill (Last-Event-ID) are handled by the browser + Chatpack;
// delivery is at-least-once, so we dedupe by message id.

function startStream() {
  stream = new EventSource(`${BASE}/stream`);

  stream.addEventListener("message.created", (e) => {
    const { message } = JSON.parse(e.data);
    if (current && message.conversationId === current.id) {
      if (message.senderId !== me.id) hideTyping(); // they sent - not typing anymore
      if (!messages.some((m) => m.id === message.id)) {
        messages.push(message);
        renderMessages();
        scrollToBottom();
        markRead();
      }
    } else {
      unread.add(message.conversationId);
    }
    bumpConversation(message.conversationId);
  });

  const applyUpdate = (e) => {
    const { message } = JSON.parse(e.data);
    if (!current || message.conversationId !== current.id) return;
    const index = messages.findIndex((m) => m.id === message.id);
    if (index !== -1) {
      messages[index] = message;
      renderMessages();
    }
  };
  stream.addEventListener("message.updated", applyUpdate);
  stream.addEventListener("message.deleted", applyUpdate);

  // Ephemeral plugin events (§10). Unlike message events they carry no SSE id
  // and are never replayed on reconnect - miss one and it's simply gone.
  stream.addEventListener("typing.started", (e) => {
    const { conversationId, senderId } = JSON.parse(e.data);
    if (current && conversationId === current.id) showTyping(senderId);
  });
  stream.addEventListener("typing.stopped", (e) => {
    const { conversationId } = JSON.parse(e.data);
    if (current && conversationId === current.id) hideTyping();
  });

  const applyPresence = (e) => {
    const { senderId, payload } = JSON.parse(e.data);
    presenceByUser.set(senderId, { online: payload.online, lastSeenAt: payload.lastSeenAt });
    renderSidebar();
    renderThreadStatus();
  };
  stream.addEventListener("presence.online", applyPresence);
  stream.addEventListener("presence.offline", applyPresence);

  stream.addEventListener("receipt.delivered", (e) => {
    const { conversationId, payload } = JSON.parse(e.data);
    // Ticks are at-least-once; keeping the max seq makes duplicates harmless.
    deliveredSeq.set(conversationId, Math.max(deliveredSeq.get(conversationId) ?? 0, payload.seq));
    if (current && conversationId === current.id) renderMessages();
  });

  stream.addEventListener("receipt.read", (e) => {
    const { conversationId, senderId, payload } = JSON.parse(e.data);
    if (!current || conversationId !== current.id) return;
    const participant = current.participants.find((p) => p.userId === senderId);
    if (participant) participant.lastReadMessageId = payload.messageId;
    renderMessages(); // moves the "Seen" label instantly
  });

  stream.onerror = () => {
    // CLOSED = fatal (e.g. session expired -> 401): EventSource will NOT
    // retry. Anything else is a dropped connection and retries automatically.
    if (stream.readyState === EventSource.CLOSED) location.reload();
  };
}

async function bumpConversation(conversationId) {
  const index = conversations.findIndex((c) => c.id === conversationId);
  if (index === -1) {
    // first message of a conversation someone else started with me
    const { conversation } = await api(`/conversations/${conversationId}`);
    conversations.unshift(conversation);
    refreshPresence(); // a brand-new partner - fetch their presence too
  } else {
    conversations.unshift(conversations.splice(index, 1)[0]);
  }
  renderSidebar();
}

// --- 10. real-time plugins: typing, presence, ✓/✓✓ ticks -----------------------
// Enabled server-side with `plugins: [typing(), presence(), receipts()]`.
// Everything here is ephemeral - never stored, never replayed - so the durable
// truth (message history, lastReadMessageId) is always what's in storage.

// Typing: while the user types, ping at most every 2.5s. The other side clears
// the indicator if no ping arrives within 5s (see showTyping), so a client
// that vanishes mid-keystroke can't leave a stuck "is typing…".
$("composer-input").addEventListener("input", () => {
  if (!current || $("composer-input").value === "") return;
  const now = Date.now();
  if (now - lastTypingSentAt < 2500) return;
  lastTypingSentAt = now;
  api(`/conversations/${current.id}/typing`, {
    method: "POST",
    body: { isTyping: true },
  }).catch(() => {});
});

function showTyping(senderId) {
  $("typing").textContent = `${senderId} is typing…`;
  $("typing").classList.remove("hidden");
  clearTimeout(typingHideTimer);
  typingHideTimer = setTimeout(hideTyping, 5000);
}

function hideTyping() {
  $("typing").classList.add("hidden");
  clearTimeout(typingHideTimer);
}

// Presence: live transitions arrive on the stream (presence.online/offline);
// this fetches the initial snapshot for everyone in the sidebar.
async function refreshPresence() {
  const ids = [...new Set(conversations.map(otherUser))].filter((id) => id !== me.id);
  if (ids.length === 0) return;
  const { presence } = await api(`/presence?userIds=${encodeURIComponent(ids.join(","))}`);
  for (const [id, info] of Object.entries(presence)) presenceByUser.set(id, info);
  renderSidebar();
  renderThreadStatus();
}

function renderThreadStatus() {
  if (!current) return;
  const info = presenceByUser.get(otherUser(current));
  const el = $("thread-status");
  el.classList.toggle("online", Boolean(info?.online));
  el.textContent = info?.online
    ? "online"
    : info?.lastSeenAt
      ? "last seen " +
        new Date(info.lastSeenAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
}

// --- rendering ---------------------------------------------------------------

function renderMessages() {
  $("load-older").classList.toggle("hidden", olderCursor === null);
  const list = $("message-list");
  list.innerHTML = "";
  const seenId = lastSeenMessageId();

  for (const message of messages) {
    const el = document.createElement("div");
    el.className = "msg" + (message.senderId === me.id ? " mine" : "");

    const body = document.createElement("div");
    body.className = "body" + (message.deletedAt ? " deleted" : "");
    body.textContent = message.deletedAt ? "message deleted" : message.body;
    el.appendChild(body);

    const meta = document.createElement("div");
    meta.className = "meta";
    // Timestamps arrive as ISO strings over HTTP.
    meta.textContent =
      new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
      (message.editedAt && !message.deletedAt ? " · edited" : "");
    // ✓ = sent (stored); ✓✓ = the other side's live stream received it
    // (`receipt.delivered`). "Seen" below stays the durable read marker.
    if (message.senderId === me.id && !message.deletedAt) {
      const ticks = document.createElement("span");
      const delivered = (deliveredSeq.get(message.conversationId) ?? 0) >= message.seq;
      ticks.className = "ticks" + (delivered ? " delivered" : "");
      ticks.textContent = delivered ? "✓✓" : "✓";
      meta.appendChild(ticks);
    }
    el.appendChild(meta);

    if (message.senderId === me.id && !message.deletedAt) {
      const actions = document.createElement("div");
      actions.className = "actions";
      const edit = document.createElement("button");
      edit.textContent = "edit";
      edit.addEventListener("click", () => editMessage(message));
      const del = document.createElement("button");
      del.textContent = "delete";
      del.addEventListener("click", () => deleteMessage(message));
      actions.append(edit, del);
      el.appendChild(actions);
    }

    list.appendChild(el);

    if (message.id === seenId) {
      const seen = document.createElement("div");
      seen.className = "seen";
      seen.textContent = "Seen";
      list.appendChild(seen);
    }
  }
}

function scrollToBottom() {
  const container = $("messages");
  container.scrollTop = container.scrollHeight;
}

// --- boot ----------------------------------------------------------------------

async function enterApp() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("me-label").textContent = me.id;
  await loadConversations();
  startStream();
  refreshPresence();
}

(async () => {
  me = await whoAmI();
  if (me) enterApp();
  else $("login").classList.remove("hidden");
})();
