"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronLeft, Clipboard, Code2, Laptop, Smartphone, Tablet } from "lucide-react";
import { blockSources } from "./block-sources";

type Category = "Layout" | "Input" | "Realtime" | "Groups" | "Moderation" | "Media" | "Primitives";
type ViewMode = "preview" | "code";

interface BlockDefinition {
  category: Category;
  name: string;
  description: string;
  component: string;
  slug: string;
}

const categories: Array<"All" | Category> = [
  "All",
  "Layout",
  "Input",
  "Realtime",
  "Groups",
  "Moderation",
  "Media",
  "Primitives",
];

const blocks: BlockDefinition[] = [
  ["Layout", "Conversation list", "Sidebar with unread badges, presence dots, and live updates."],
  ["Layout", "Compact chat list", "Avatar-only rail for narrow navigation and widgets."],
  ["Layout", "Conversation header", "Title bar with member count, online state, and actions."],
  ["Layout", "Message thread", "Live history with replies, reactions, and read state."],
  ["Layout", "Flat message thread", "Slack-style rows with a compact message rhythm."],
  ["Layout", "Grouped message thread", "Message history grouped into a conversation surface."],
  ["Layout", "Chat window", "Header, thread, typing, and composer in one panel."],
  ["Layout", "Inbox layout", "Conversation list and selected chat in a two-pane shell."],
  ["Layout", "Mobile chat sheet", "One-pane chat flow with back navigation."],
  ["Layout", "Floating chat widget", "Compact rail and chat window in a floating panel."],
  ["Input", "Message composer", "Enter sends; Shift+Enter creates a new line."],
  ["Input", "Reply composer", "Composer variant with an active quote target."],
  ["Input", "Mention composer", "Composer with participant mention selection."],
  ["Input", "Message actions", "Edit, delete, reply, and forward actions."],
  ["Input", "Forward dialog", "Forward a readable message to another conversation."],
  ["Input", "Message search", "Participant-scoped search with selectable results."],
  ["Input", "Quick reactions", "Fast reaction toggles driven by message state."],
  ["Realtime", "Typing indicator", "Ephemeral “X is typing…” presence from the plugin."],
  ["Realtime", "Typing dots", "Animated bubble variant that reserves its own row height."],
  ["Realtime", "Connection status", "Small chip for live, polling, and reconnecting state."],
  ["Realtime", "Presence bar", "Compact presence row for a supplied user list."],
  ["Realtime", "Read receipts", "Delivered and read state for the newest message."],
  ["Groups", "Members list", "Current participants with role-aware presentation."],
  ["Groups", "Participant manager", "Add, remove, and promote group participants."],
  ["Groups", "Invite manager", "Create, copy, list, and revoke invite links."],
  ["Groups", "Channel directory", "Browse public channels and join with one action."],
  ["Moderation", "Blocked users", "Viewer-scoped blocked-user management."],
  ["Moderation", "Report dialog", "Submit a report for a user or message target."],
  ["Moderation", "Moderation queue", "Review and update report lifecycle state."],
  ["Media", "Attachment composer", "Select files and return them to the host."],
  ["Media", "Attachment dropzone", "Pass dropped or selected files to the host."],
  ["Media", "Message attachments", "Render Filepack references with authorized targets."],
  ["Media", "Image bubble", "Resolve and display a short-lived image target."],
  ["Media", "File bubble", "Resolve and render an authorized download link."],
  ["Primitives", "User avatar", "Initials fallback for an opaque user id."],
  ["Primitives", "Message bubble", "Own and other-person message treatment."],
  ["Primitives", "Timestamp", "Readable created-at label for a message."],
  ["Primitives", "Presence dot", "Small online or offline state indicator."],
  ["Primitives", "Read receipt ticks", "Sent, delivered, and read tick treatment."],
  ["Primitives", "Reaction pill", "Pressed state and count for one emoji reaction."],
  ["Primitives", "Reply quote bar", "Compact preview of the quoted parent message."],
  ["Primitives", "Empty state", "Quiet placeholder for a missing selection or result."],
].map(([category, name, description]) => ({
  category: category as Category,
  name,
  description,
  component: name
    .split(" ")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(""),
  slug: name.toLowerCase().replaceAll(" ", "-"),
}));

const featuredBlocks = [
  {
    name: "Floating chat widget",
    description: "Compact rail + chat window in a floating panel.",
    kind: "widget" as const,
  },
  {
    name: "Chat window",
    description: "Header + thread + typing + composer composed into one panel.",
    kind: "window" as const,
  },
];

function sourceText(block: BlockDefinition): string {
  const source = blockSources[block.component];
  return source === undefined ? "" : `// packages/ui/src/${source.file}\n${source.code}`;
}

export function BlocksGallery() {
  const [activeCategory, setActiveCategory] = useState<(typeof categories)[number]>("All");
  const [selected, setSelected] = useState<BlockDefinition | null>(null);
  const [mode, setMode] = useState<ViewMode>("preview");
  const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const filteredBlocks = useMemo(
    () =>
      activeCategory === "All"
        ? blocks
        : blocks.filter((block) => block.category === activeCategory),
    [activeCategory],
  );

  useEffect(() => {
    const syncSelection = () => {
      const slug = window.location.hash.replace(/^#block-/, "");
      setSelected(blocks.find((block) => block.slug === slug) ?? null);
    };
    syncSelection();
    window.addEventListener("popstate", syncSelection);
    window.addEventListener("hashchange", syncSelection);
    return () => {
      window.removeEventListener("popstate", syncSelection);
      window.removeEventListener("hashchange", syncSelection);
    };
  }, []);

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = window.setTimeout(() => setCopyStatus("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  async function copyCode(): Promise<void> {
    if (selected === null) return;
    const code = sourceText(selected);
    if (code === "") {
      setCopyStatus("error");
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

  function openBlock(block: BlockDefinition): void {
    window.history.pushState(null, "", `#block-${block.slug}`);
    setSelected(block);
    setMode("preview");
    setDevice("desktop");
    setCopyStatus("idle");
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function showCatalog(): void {
    window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    setSelected(null);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function selectCategory(category: (typeof categories)[number]): void {
    setActiveCategory(category);
  }

  return (
    <section className="chatpack-gallery" aria-label="Chatpack UI block gallery">
      {selected === null ? (
        <>
          <div className="chatpack-gallery-section-heading">
            <span>Featured</span>
            <h3>Composed chat UIs</h3>
          </div>
          <div className="chatpack-gallery-featured">
            {featuredBlocks.map((block) => (
              <button
                className="chatpack-gallery-feature-card"
                key={block.name}
                type="button"
                onClick={() => {
                  const next = blocks.find((item) => item.name === block.name);
                  if (next !== undefined) openBlock(next);
                }}
              >
                <div className="chatpack-gallery-card-stage" aria-hidden="true">
                  <span className="chatpack-gallery-card-category">Layout</span>
                  {block.kind === "widget" ? <WidgetPreview /> : <ChatWindowPreview />}
                </div>
                <span className="chatpack-gallery-card-copy">
                  <strong>{block.name}</strong>
                  <small>{block.description}</small>
                </span>
              </button>
            ))}
          </div>

          <div className="chatpack-gallery-catalog-heading">
            <div>
              <span>Catalog</span>
              <h3>{blocks.length} UI blocks</h3>
            </div>
            <div
              className="chatpack-gallery-tabs"
              aria-label="Filter blocks by category"
              role="group"
            >
              {categories.map((category) => (
                <button
                  aria-pressed={activeCategory === category}
                  className={activeCategory === category ? "is-active" : undefined}
                  key={category}
                  type="button"
                  onClick={() => selectCategory(category)}
                >
                  {category}
                </button>
              ))}
            </div>
          </div>
          <div className="chatpack-gallery-grid">
            {filteredBlocks.map((block) => (
              <button
                className="chatpack-gallery-card"
                key={block.name}
                type="button"
                onClick={() => openBlock(block)}
              >
                <div className="chatpack-gallery-card-stage" aria-hidden="true">
                  <span className="chatpack-gallery-card-category">{block.category}</span>
                  <CardPreview block={block} />
                </div>
                <span className="chatpack-gallery-card-copy">
                  <strong>{block.name}</strong>
                  <small>{block.description}</small>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="chatpack-gallery-selected">
          <button className="chatpack-gallery-back" type="button" onClick={showCatalog}>
            <ChevronLeft size={16} aria-hidden="true" /> All blocks
          </button>
          <div className="chatpack-gallery-selected-heading">
            <span>
              {selected.category} / {selected.component}
            </span>
            <h1>{selected.name}</h1>
            <p>{selected.description}</p>
          </div>
          <p className="chatpack-gallery-note">
            Preview uses sample content. Install <code>@chatpack/ui</code> to use this export.
            Connected blocks also need a configured client.
          </p>
          <div className="chatpack-gallery-detail">
            <div className="chatpack-gallery-detail-toolbar">
              <div
                className="chatpack-gallery-mode-tabs"
                role="group"
                aria-label="Block detail view"
              >
                {(["preview", "code"] as const).map((item) => (
                  <button
                    aria-pressed={mode === item}
                    className={mode === item ? "is-active" : undefined}
                    key={item}
                    type="button"
                    onClick={() => setMode(item)}
                  >
                    {item === "code" && <Code2 size={14} aria-hidden="true" />}
                    {item[0].toUpperCase() + item.slice(1)}
                  </button>
                ))}
              </div>
              {mode === "preview" && (
                <div className="chatpack-gallery-device-tabs" aria-label="Preview size">
                  {(["desktop", "tablet", "mobile"] as const).map((item) => (
                    <button
                      aria-label={`${item[0].toUpperCase() + item.slice(1)} preview`}
                      aria-pressed={device === item}
                      className={device === item ? "is-active" : undefined}
                      key={item}
                      type="button"
                      onClick={() => setDevice(item)}
                    >
                      {item === "desktop" ? (
                        <Laptop size={16} />
                      ) : item === "tablet" ? (
                        <Tablet size={16} />
                      ) : (
                        <Smartphone size={16} />
                      )}
                    </button>
                  ))}
                </div>
              )}
              <button
                className="chatpack-gallery-copy-button"
                type="button"
                onClick={() => void copyCode()}
              >
                {copyStatus === "copied" ? <Check size={14} /> : <Clipboard size={14} />}
                {copyStatus === "copied"
                  ? "Copied"
                  : copyStatus === "error"
                    ? "Copy failed"
                    : "Copy source"}
              </button>
            </div>
            {mode === "preview" ? (
              <div className={`chatpack-gallery-detail-preview is-${device}`}>
                <div className="chatpack-gallery-detail-canvas">
                  <CardPreview block={selected} />
                </div>
              </div>
            ) : (
              <pre className="chatpack-gallery-code">
                <code>{sourceText(selected)}</code>
              </pre>
            )}
          </div>
          <p className="chatpack-gallery-source-note">
            Source excerpt from{" "}
            <code>packages/ui/src/{blockSources[selected.component]?.file}</code>. Package imports
            and provider setup appear in the install guide below.
          </p>
          <span className="sr-only" role="status" aria-live="polite">
            {copyStatus === "copied"
              ? "Source copied to clipboard"
              : copyStatus === "error"
                ? "Unable to copy source"
                : ""}
          </span>
        </div>
      )}
    </section>
  );
}

function CardPreview({ block }: { block: BlockDefinition }) {
  switch (block.category) {
    case "Layout":
      if (block.name === "Conversation list") return <ConversationListPreview />;
      if (block.name === "Compact chat list") return <CompactListPreview />;
      if (block.name === "Conversation header") return <HeaderPreview />;
      if (block.name === "Chat window") return <ChatWindowPreview />;
      if (block.name === "Inbox layout") return <InboxPreview />;
      if (block.name === "Mobile chat sheet") return <MobileSheetPreview />;
      if (block.name === "Floating chat widget") return <WidgetPreview />;
      return <ThreadPreview name={block.name} />;
    case "Input":
      return <InputPreview name={block.name} />;
    case "Realtime":
      return <RealtimePreview name={block.name} />;
    case "Groups":
      return <GroupPreview name={block.name} />;
    case "Moderation":
      return <ModerationPreview name={block.name} />;
    case "Media":
      return <MediaPreview name={block.name} />;
    case "Primitives":
      return <PrimitivePreview name={block.name} />;
  }
}

function Avatar({ initials, blue = false }: { initials: string; blue?: boolean }) {
  return <span className={`chatpack-avatar${blue ? " is-blue" : ""}`}>{initials}</span>;
}

function LiveBadge() {
  return (
    <span className="chatpack-live-badge">
      <span /> live
    </span>
  );
}

function MessageSample({ own = false, children }: { own?: boolean; children: ReactNode }) {
  return <span className={`chatpack-message${own ? " is-own" : ""}`}>{children}</span>;
}

function ConversationListPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-list">
      <div className="chatpack-list-header">
        <span>
          <strong>Messages</strong>
          <small>Signed in as alice</small>
        </span>
        <span className="chatpack-open-badge">● open</span>
      </div>
      <div className="chatpack-conversation-row">
        <Avatar initials="#" />
        <span>
          <strong>Design team</strong>
          <small>3 members</small>
        </span>
      </div>
      <div className="chatpack-conversation-row">
        <Avatar initials="BO" />
        <span>
          <strong>Bob</strong>
          <small>Last message today</small>
        </span>
        <b>3</b>
      </div>
      <div className="chatpack-conversation-row">
        <Avatar initials="CA" />
        <span>
          <strong>Carol</strong>
          <small>See you soon</small>
        </span>
        <b>1</b>
      </div>
    </div>
  );
}

function CompactListPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-compact">
      <div className="chatpack-compact-rail">
        <strong>TEAM</strong>
        <Avatar initials="B" />
        <Avatar initials="C" />
        <Avatar initials="#" />
      </div>
      <div className="chatpack-compact-pane">
        <span>Select a conversation</span>
      </div>
    </div>
  );
}

function HeaderPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-center">
      <div className="chatpack-preview-header">
        <Avatar initials="#" />
        <span>
          <strong>Design team</strong>
          <small>3 members</small>
        </span>
        <span className="chatpack-header-action">⋯</span>
      </div>
    </div>
  );
}

function ThreadPreview({ name }: { name: string }) {
  return (
    <div
      className={`chatpack-preview chatpack-preview-thread${name === "Flat message thread" ? " is-flat" : ""}`}
    >
      <div className="chatpack-thread-title">Messages</div>
      <div className="chatpack-thread-rows">
        <div>
          <Avatar initials="BO" />
          <span>
            <small>Bob · 05:08 PM</small>
            <MessageSample>I&apos;ll check the conversation list and unread states</MessageSample>
          </span>
        </div>
        <div>
          <Avatar initials="CA" />
          <span>
            <small>Carol · 05:08 PM</small>
            <MessageSample>I&apos;ll polish the group header and member roles</MessageSample>
          </span>
        </div>
        <MessageSample own>Morning team — final UI pass today</MessageSample>
      </div>
    </div>
  );
}

function ChatWindowPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-window">
      <div className="chatpack-preview-header">
        <Avatar initials="#" />
        <span>
          <strong>Design team</strong>
          <small>3 members</small>
        </span>
      </div>
      <div className="chatpack-window-status">
        <LiveBadge />
      </div>
      <div className="chatpack-thread-title">Messages</div>
      <div className="chatpack-preview-messages">
        <MessageSample own>
          <small>You · 05:05 PM</small>Morning team — final UI pass today
          <span className="chatpack-reaction">👍 3</span>
        </MessageSample>
        <MessageSample>
          <small>Bob · 05:08 PM</small>I&apos;ll check the conversation list and unread states
        </MessageSample>
        <MessageSample>
          <small>Carol · 05:08 PM</small>I&apos;ll polish the group header and member roles
        </MessageSample>
      </div>
      <div className="chatpack-preview-composer">
        <span>Write a message...</span>
        <span className="chatpack-send">➤</span>
      </div>
      <small className="chatpack-preview-help">Enter to send · Shift+Enter for a new line</small>
    </div>
  );
}

function InboxPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-inbox">
      <ConversationListPreview />
      <div className="chatpack-inbox-empty">Select a conversation</div>
    </div>
  );
}

function MobileSheetPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-mobile-sheet">
      <div className="chatpack-mobile-heading">
        ‹ <strong>Design team</strong>
      </div>
      <ThreadPreview name="Message thread" />
      <div className="chatpack-preview-composer">
        Write a message... <span className="chatpack-send">➤</span>
      </div>
    </div>
  );
}

function WidgetPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-widget">
      <div className="chatpack-widget-rail">
        <strong>TEAM</strong>
        <Avatar initials="B" blue />
        <Avatar initials="C" />
      </div>
      <div className="chatpack-widget-window">
        <div className="chatpack-preview-header">
          <strong>Messages</strong>
          <span>×</span>
        </div>
        <div className="chatpack-widget-status">
          <LiveBadge />
        </div>
        <div className="chatpack-inbox-empty">Select a conversation</div>
      </div>
    </div>
  );
}

function InputPreview({ name }: { name: string }) {
  if (name === "Message actions")
    return (
      <div className="chatpack-preview chatpack-preview-input">
        <MessageSample>I&apos;ll polish the group header and member roles</MessageSample>
        <div className="chatpack-action-row">
          <span>↩ Reply</span>
          <span>↪ Forward</span>
          <span>⋯ More</span>
        </div>
        <small>Edit and delete appear on your own messages.</small>
      </div>
    );
  if (name === "Forward dialog")
    return (
      <div className="chatpack-preview chatpack-preview-input">
        <div className="chatpack-form">
          <strong>↪ Forward message</strong>
          <p>I&apos;ll polish the group header and member roles</p>
          <span>
            Bob <small>direct</small>
          </span>
          <span>
            Carol <small>direct</small>
          </span>
        </div>
      </div>
    );
  if (name === "Message search")
    return (
      <div className="chatpack-preview chatpack-preview-input">
        <div className="chatpack-form">
          <span>⌕ &nbsp; Search messages...</span>
          <p>Type a word from any of your conversations.</p>
        </div>
      </div>
    );
  if (name === "Quick reactions")
    return (
      <div className="chatpack-preview chatpack-preview-input">
        <MessageSample>Morning team — final UI pass today</MessageSample>
        <div className="chatpack-action-row">
          <span>👍</span>
          <span>❤️</span>
          <span>😂</span>
          <span>🎉</span>
          <span>👀</span>
        </div>
      </div>
    );
  return (
    <div className="chatpack-preview chatpack-preview-input">
      {name === "Reply composer" && (
        <div className="chatpack-reply-bar">
          ↩ Replying to Bob <span>×</span>
        </div>
      )}
      <div className="chatpack-preview-composer">
        <span>{name === "Mention composer" ? "Hi @bo" : "Write a message..."}</span>
        <span className="chatpack-send">➤</span>
      </div>
      {name === "Mention composer" && (
        <div className="chatpack-mention-menu">
          <span>
            <Avatar initials="BO" /> Bob
          </span>
          <span>
            <Avatar initials="CA" /> Carol
          </span>
        </div>
      )}
      <small className="chatpack-preview-help">Enter to send · Shift+Enter for a new line</small>
    </div>
  );
}

function RealtimePreview({ name }: { name: string }) {
  if (name === "Presence bar")
    return (
      <div className="chatpack-preview chatpack-preview-realtime">
        <div className="chatpack-presence-row">
          <Avatar initials="AL" blue />
          <Avatar initials="BO" />
          <Avatar initials="CA" />
          <span>3 online</span>
        </div>
      </div>
    );
  if (name === "Read receipts")
    return (
      <div className="chatpack-preview chatpack-preview-realtime">
        <MessageSample own>Morning team — final UI pass today</MessageSample>
        <small className="chatpack-receipt">✓✓ &nbsp; Read by Bob and Carol</small>
      </div>
    );
  if (name === "Connection status")
    return (
      <div className="chatpack-preview chatpack-preview-realtime">
        <div className="chatpack-connection">
          <LiveBadge />
          <span>Reconnects automatically.</span>
        </div>
      </div>
    );
  return (
    <div className="chatpack-preview chatpack-preview-realtime">
      {name === "Typing dots" ? (
        <div className="chatpack-typing-dots">● ● ●</div>
      ) : (
        <div className="chatpack-typing-text">Bob is typing...</div>
      )}
      <small>Typing state appears while participants write.</small>
    </div>
  );
}

function GroupPreview({ name }: { name: string }) {
  if (name === "Channel directory")
    return (
      <div className="chatpack-preview chatpack-preview-group">
        <div className="chatpack-form">
          <strong>Browse channels</strong>
          <span>
            # design-team <small>Join</small>
          </span>
          <span>
            # product <small>Join</small>
          </span>
        </div>
      </div>
    );
  if (name === "Invite manager")
    return (
      <div className="chatpack-preview chatpack-preview-group">
        <div className="chatpack-form">
          <strong>Invite links</strong>
          <span>
            chatpack.dev/invite/… <small>Copy</small>
          </span>
          <span>2 active invites</span>
        </div>
      </div>
    );
  if (name === "Participant manager")
    return (
      <div className="chatpack-preview chatpack-preview-group">
        <div className="chatpack-form">
          <strong>Members</strong>
          <span>
            Alice <small>Owner</small>
          </span>
          <span>
            Bob <small>Member</small>
          </span>
          <span>
            Carol <small>Member</small>
          </span>
        </div>
      </div>
    );
  return (
    <div className="chatpack-preview chatpack-preview-group">
      <div className="chatpack-form">
        <strong>Design team</strong>
        <span>3 members</span>
        <div className="chatpack-presence-row">
          <Avatar initials="AL" blue />
          <Avatar initials="BO" />
          <Avatar initials="CA" />
        </div>
      </div>
    </div>
  );
}

function ModerationPreview({ name }: { name: string }) {
  return (
    <div className="chatpack-preview chatpack-preview-moderation">
      <div className="chatpack-form">
        <strong>{name}</strong>
        {name === "Blocked users" ? (
          <>
            <span>Blocked accounts</span>
            <span>
              2 people <small>Manage</small>
            </span>
          </>
        ) : name === "Report dialog" ? (
          <>
            <span>Report a message</span>
            <p>Tell moderators what happened.</p>
            <span className="chatpack-sample-action">Submit report</span>
          </>
        ) : (
          <>
            <span>
              Open reports <small>3</small>
            </span>
            <span>
              Review reports <small>Open queue</small>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function MediaPreview({ name }: { name: string }) {
  return (
    <div className="chatpack-preview chatpack-preview-media">
      <div className="chatpack-media-art">
        {name === "Image bubble"
          ? "▧"
          : name === "File bubble" || name === "Message attachments"
            ? "▤"
            : "＋"}
      </div>
      <strong>
        {name === "Image bubble"
          ? "Image preview"
          : name === "File bubble"
            ? "design-notes.pdf"
            : name === "Message attachments"
              ? "2 attachments"
              : "Attach files"}
      </strong>
      <small>
        {name === "Attachment dropzone" ? "Drop files here" : "Files are resolved by your app"}
      </small>
    </div>
  );
}

function PrimitivePreview({ name }: { name: string }) {
  if (name === "User avatar")
    return (
      <div className="chatpack-preview chatpack-preview-primitive">
        <Avatar initials="BO" blue />
        <span>Bob</span>
      </div>
    );
  if (name === "Timestamp")
    return (
      <div className="chatpack-preview chatpack-preview-primitive">
        <span className="chatpack-time">05:08 PM</span>
      </div>
    );
  if (name === "Presence dot")
    return (
      <div className="chatpack-preview chatpack-preview-primitive">
        <Avatar initials="BO" />
        <span className="chatpack-presence-dot" />
        <span>Bob is online</span>
      </div>
    );
  if (name === "Read receipt ticks")
    return (
      <div className="chatpack-preview chatpack-preview-primitive">
        <span className="chatpack-ticks">✓✓</span>
        <span>Read</span>
      </div>
    );
  if (name === "Reaction pill")
    return (
      <div className="chatpack-preview chatpack-preview-primitive">
        <span className="chatpack-reaction-pill">👍 3</span>
      </div>
    );
  if (name === "Reply quote bar")
    return (
      <div className="chatpack-preview chatpack-preview-primitive">
        <div className="chatpack-reply-bar">
          Bob <small>I&apos;ll check the conversation list...</small>
        </div>
      </div>
    );
  if (name === "Empty state")
    return (
      <div className="chatpack-preview chatpack-preview-primitive">
        <span>Select a conversation</span>
      </div>
    );
  return (
    <div className="chatpack-preview chatpack-preview-primitive">
      <MessageSample own>Morning team — final UI pass today</MessageSample>
    </div>
  );
}
