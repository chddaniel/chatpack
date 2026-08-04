/**
 * The demo Chatpack backend used by the copy-paste UI blocks.
 *
 * DESIGN CONSTRAINT that shapes this whole file: the callers are AI-builder
 * previews (Lovable, v0, Shipper, Bolt) running on a DIFFERENT origin, usually
 * inside a cross-site iframe. Third-party cookies are blocked or partitioned
 * there, so the usual `demo_user` cookie recipe cannot be relied on.
 *
 * So this demo authenticates from the URL instead:
 *
 *     https://demo-api.chatpack.dev/api/chat/u/<sandbox>/<userId>/conversations
 *
 * `<userId>` is the demo identity (alice, bob, ...) and `<sandbox>` scopes the
 * data so two unrelated builders never see each other's messages. Both are
 * plain path segments, which means:
 *   - no cookies, no CORS credentials, no `SameSite` puzzle
 *   - `EventSource` works (it cannot send custom headers, but it can fetch a URL)
 *   - a block only has to set the client's `baseURL` + `basePath` once
 *
 * This is a DEMO-ONLY pattern: anyone who knows the URL can act as that user.
 * Real apps resolve a session/JWT in the `auth` hook instead - see llms.txt.
 */
import { chatpack, type ChatpackInstance } from "@chatpack/core";
import { typing, presence, receipts } from "@chatpack/core/plugins";
import { memoryAdapter } from "@chatpack/adapter-memory";

/** Where the demo identity lives in the path: /api/chat/u/<sandbox>/<userId> */
const IDENTITY_PATTERN = /\/api\/chat\/u\/([^/]+)\/([^/]+)/;

/** Parsed demo identity for one request. */
export interface DemoIdentity {
  sandbox: string;
  userId: string;
  /** The path prefix to hand `chat.handler({ basePath })` for this request. */
  basePath: string;
}

/** Only lowercase letters, digits, and dashes - keeps ids readable and safe. */
function sanitizeSegment(raw: string): string {
  return decodeURIComponent(raw)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40);
}

/**
 * Read the sandbox + demo user out of a request URL.
 *
 * Returns `null` when the path is not one of the identity-scoped routes, which
 * is how unauthenticated requests (and the landing page) fall through.
 */
export function readIdentity(request: Request): DemoIdentity | null {
  const match = IDENTITY_PATTERN.exec(new URL(request.url).pathname);
  if (match === null) return null;

  const sandbox = sanitizeSegment(match[1] ?? "");
  const userId = sanitizeSegment(match[2] ?? "");
  if (sandbox === "" || userId === "") return null;

  return { sandbox, userId, basePath: `/api/chat/u/${sandbox}/${userId}` };
}

/**
 * One Chatpack instance per sandbox, cached on `globalThis`.
 *
 * `memoryAdapter` is per-process, so this only holds together while a single
 * warm instance serves the traffic - exactly the documented demo tradeoff
 * (llms.txt deployment table). Data is expected to vanish on cold starts;
 * the seeding below makes that harmless.
 */
const globalCache = globalThis as typeof globalThis & {
  __chatpackDemo__?: Map<string, ChatpackInstance>;
};
const instances = (globalCache.__chatpackDemo__ ??= new Map<string, ChatpackInstance>());

/** Hard cap on live sandboxes so a crawler cannot grow the map forever. */
const MAX_SANDBOXES = 200;

/** Longest message this demo accepts, enforced by `beforeMessageSend`. */
export const MAX_BODY_LENGTH = 2000;

/** Get (or lazily create) the Chatpack instance for one sandbox. */
export function chatFor(identity: DemoIdentity): ChatpackInstance {
  const existing = instances.get(identity.sandbox);
  if (existing !== undefined) return existing;

  if (instances.size >= MAX_SANDBOXES) {
    // Evict the oldest sandbox - Map preserves insertion order.
    const oldest = instances.keys().next();
    if (!oldest.done) instances.delete(oldest.value);
  }

  const instance = chatpack({
    storage: memoryAdapter(),
    plugins: [typing(), presence(), receipts()],
    // The user is already resolved from the path before we get here; every
    // request that reaches a handler is authenticated by construction.
    auth: (request) => {
      const parsed = readIdentity(request);
      return parsed === null ? null : { id: parsed.userId };
    },
    hooks: {
      // Keep the public demo tidy: trim, and reject anything oversized. A
      // throwing before-hook becomes a 422 MESSAGE_REJECTED with this text
      // (ADR 0011), so the client shows a useful error.
      beforeMessageSend: ({ body }) => {
        const trimmed = body.trim();
        if (trimmed.length > MAX_BODY_LENGTH) {
          throw new Error(`Demo backend: messages are limited to ${MAX_BODY_LENGTH} characters.`);
        }
        return { body: trimmed };
      },
    },
  });

  instances.set(identity.sandbox, instance);
  return instance;
}

/**
 * Give a brand-new sandbox something to render.
 *
 * A UI block is useless against an empty backend - a vibe coder would see an
 * empty state and assume they wired it wrong. So the first time a sandbox is
 * touched we plant two conversations with a short scripted history, including
 * an edited message, a deleted one (tombstone), reactions, and a quote-reply
 * so blocks can be checked against the awkward states, not just the happy path.
 */
const seeded = new Set<string>();

interface SeedLine {
  from: string;
  to: string;
  body: string;
}

const SEED_SCRIPT: readonly SeedLine[] = [
  { from: "bob", to: "alice", body: "hey! are we still on for tomorrow?" },
  { from: "alice", to: "bob", body: "yes - 10am works. want me to bring the design files?" },
  { from: "bob", to: "alice", body: "please do. the new bubbles look great btw" },
  { from: "alice", to: "bob", body: "thanks! I reworked the spacing this morning" },
  { from: "carol", to: "alice", body: "quick one: did the deploy go through?" },
  { from: "alice", to: "carol", body: "it did - green across the board" },
];

export async function ensureSeeded(identity: DemoIdentity): Promise<void> {
  const key = identity.sandbox;
  if (seeded.has(key)) return;
  seeded.add(key);

  const chat = chatFor(identity);
  try {
    // Remember one early message per conversation so the reply below has a
    // parent that is NOT the newest message - that is the case a quote bar has
    // to look right in (reply far from its parent in the transcript).
    let firstBobLine: string | undefined;

    for (const line of SEED_SCRIPT) {
      const conversation = await chat.api.getOrCreateConversation({
        userId: line.from,
        otherUserId: line.to,
      });
      const sent = await chat.api.sendMessage({
        userId: line.from,
        conversationId: conversation.id,
        body: line.body,
      });
      firstBobLine ??= sent.id;
    }

    // One edited + one deleted message so tombstone and "edited" styling are
    // reachable without the vibe coder having to produce them by hand.
    const aliceBob = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const extra = await chat.api.sendMessage({
      userId: "bob",
      conversationId: aliceBob.id,
      body: "typo here",
    });
    await chat.api.editMessage({ userId: "bob", messageId: extra.id, body: "typo fixed (edited)" });

    const doomed = await chat.api.sendMessage({
      userId: "alice",
      conversationId: aliceBob.id,
      body: "this one gets deleted",
    });
    await chat.api.deleteMessage({ userId: "alice", messageId: doomed.id });

    // Reactions and a quote-reply (ADR 0013), so reaction pills and reply
    // quote bars are reachable in fresh seed data too. Two users react with
    // the same emoji on purpose: that is the only way to see a count above 1
    // and a two-entry `userIds` array in a 1:1 conversation.
    if (firstBobLine !== undefined) {
      await chat.api.addReaction({ userId: "alice", messageId: firstBobLine, emoji: "👍" });
      await chat.api.addReaction({ userId: "bob", messageId: firstBobLine, emoji: "👍" });
      await chat.api.addReaction({ userId: "alice", messageId: firstBobLine, emoji: "🎉" });

      await chat.api.sendMessage({
        userId: "alice",
        conversationId: aliceBob.id,
        body: "replying to your first message here",
        replyToMessageId: firstBobLine,
      });
    }
  } catch (error) {
    // Seeding is a convenience, never a reason to fail a request.
    seeded.delete(key);
    console.error("chatpack demo: seeding failed", error);
  }
}
