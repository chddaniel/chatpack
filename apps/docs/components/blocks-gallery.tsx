"use client";

import { useMemo, useState } from "react";

type Category = "Layout" | "Input" | "Realtime" | "Groups" | "Moderation" | "Media" | "Primitives";
type ViewMode = "preview" | "code";

interface BlockDefinition {
  category: Category;
  name: string;
  description: string;
  code: string;
}

const categories: Array<"All" | Category> = [
  "All",
  "Layout",
  "Input",
  "Realtime",
  "Groups",
  "Moderation",
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
  ["Media", "Attachment dropzone", "Drop files into a keyboard-accessible upload target."],
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
  code: `<${name
    .split(" ")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join("")} />`,
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

export function BlocksGallery() {
  const [activeCategory, setActiveCategory] = useState<(typeof categories)[number]>("All");
  const [selected, setSelected] = useState<BlockDefinition>(blocks[6]!);
  const [mode, setMode] = useState<ViewMode>("preview");
  const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [copied, setCopied] = useState(false);
  const filteredBlocks = useMemo(
    () =>
      activeCategory === "All"
        ? blocks
        : blocks.filter((block) => block.category === activeCategory),
    [activeCategory],
  );

  async function copyCode(): Promise<void> {
    await navigator.clipboard?.writeText(selected.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function selectCategory(category: (typeof categories)[number]): void {
    setActiveCategory(category);
    const next =
      category === "All" ? blocks[6] : blocks.find((block) => block.category === category);
    if (next !== undefined) setSelected(next);
  }

  return (
    <section className="chatpack-gallery" aria-label="Chatpack UI block gallery">
      <div className="chatpack-gallery-intro">
        <p>
          Building blocks for chat UI — layouts, composers, realtime indicators, group admin, and
          moderation. Each one is a single file you can copy into an app — wired to
          <code>@chatpack/client</code> and the public demo backend at
          <code>demo-api.chatpack.dev</code>. No database or auth setup required to try them.
        </p>
        <p className="chatpack-gallery-note">
          Open a second tab with <code>?user=bob</code> or <code>?user=carol</code> to test realtime
          delivery and typing against the demo backend.
        </p>
      </div>

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
              if (next !== undefined) setSelected(next);
              setMode("preview");
            }}
          >
            {block.kind === "widget" ? <WidgetPreview /> : <ChatWindowPreview />}
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
          <h3>{blocks.length} copy-paste blocks</h3>
        </div>
        <div
          className="chatpack-gallery-tabs"
          aria-label="Filter blocks by category"
          role="tablist"
        >
          {categories.map((category) => (
            <button
              aria-selected={activeCategory === category}
              className={activeCategory === category ? "is-active" : undefined}
              key={category}
              role="tab"
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
            className={
              selected.name === block.name
                ? "chatpack-gallery-card is-selected"
                : "chatpack-gallery-card"
            }
            key={block.name}
            type="button"
            onClick={() => {
              setSelected(block);
              setMode("preview");
            }}
          >
            <CardPreview block={block} />
            <span className="chatpack-gallery-card-copy">
              <strong>{block.name}</strong>
              <small>{block.description}</small>
            </span>
          </button>
        ))}
      </div>

      <div className="chatpack-gallery-detail">
        <div className="chatpack-gallery-detail-toolbar">
          <div className="chatpack-gallery-mode-tabs" role="tablist" aria-label="Block detail view">
            {(["preview", "code"] as const).map((item) => (
              <button
                aria-selected={mode === item}
                className={mode === item ? "is-active" : undefined}
                key={item}
                role="tab"
                type="button"
                onClick={() => setMode(item)}
              >
                {item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
          <div className="chatpack-gallery-device-tabs" aria-label="Preview size">
            {(["desktop", "tablet", "mobile"] as const).map((item) => (
              <button
                aria-label={`${item} preview`}
                aria-pressed={device === item}
                className={device === item ? "is-active" : undefined}
                key={item}
                type="button"
                onClick={() => setDevice(item)}
              >
                {item === "desktop" ? "▰" : item === "tablet" ? "▯" : "▥"}
              </button>
            ))}
          </div>
          <button
            className="chatpack-gallery-copy-button"
            type="button"
            onClick={() => void copyCode()}
          >
            {copied ? "Copied" : `Copy ${selected.name.toLowerCase().replaceAll(" ", "-")}.tsx`}
          </button>
        </div>
        {mode === "preview" ? (
          <div className={`chatpack-gallery-detail-preview is-${device}`}>
            <ChatWindowPreview />
          </div>
        ) : (
          <pre className="chatpack-gallery-code">
            <code>{selected.code}</code>
          </pre>
        )}
      </div>
    </section>
  );
}

function CardPreview({ block }: { block: BlockDefinition }) {
  if (block.category === "Layout" && block.name === "Conversation list")
    return <ConversationListPreview />;
  if (block.category === "Layout" && block.name === "Chat window") return <ChatWindowPreview />;
  if (block.category === "Realtime") return <RealtimePreview name={block.name} />;
  if (block.category === "Input") return <ComposerPreview />;
  if (block.category === "Groups") return <GroupPreview />;
  if (block.category === "Moderation") return <ModerationPreview />;
  if (block.category === "Media") return <MediaPreview />;
  return <PrimitivePreview name={block.name} />;
}

function WidgetPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-widget">
      <div className="chatpack-mini-sidebar">
        <span className="chatpack-preview-label">MESSAGES</span>
        <span className="chatpack-avatar">BO</span>
        <span className="chatpack-avatar">CA</span>
      </div>
      <div className="chatpack-mini-pane">
        <span>Select a conversation</span>
      </div>
    </div>
  );
}

function ChatWindowPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-window">
      <div className="chatpack-preview-header">
        <span className="chatpack-avatar">#</span>
        <span>
          <b>Design team</b>
          <small>3 members</small>
        </span>
        <i>● live</i>
      </div>
      <div className="chatpack-preview-messages">
        <span className="chatpack-message is-other">
          I&apos;ll check the conversation list and unread states
        </span>
        <span className="chatpack-message is-own">
          morning team - final UI pass today <small>👍 3</small>
        </span>
        <span className="chatpack-message is-other">
          I&apos;ll polish the group header and member roles
        </span>
      </div>
      <div className="chatpack-preview-composer">
        Write a message... <b>➤</b>
      </div>
      <small className="chatpack-preview-help">Enter to send · Shift+Enter for a new line</small>
    </div>
  );
}

function ConversationListPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-list">
      <span className="chatpack-preview-label">
        MESSAGES <i>● open</i>
      </span>
      <strong>
        Design team <small>3 members</small>
      </strong>
      <span>
        BO <b>Bob</b>
        <em>3</em>
      </span>
      <span>
        CA <b>Carol</b>
        <em>1</em>
      </span>
    </div>
  );
}

function RealtimePreview({ name }: { name: string }) {
  return (
    <div className="chatpack-preview chatpack-preview-realtime">
      <span>● live</span>
      <strong>
        {name === "Connection status"
          ? "Reconnects automatically."
          : "Type — open ?user=bob in another tab"}
      </strong>
    </div>
  );
}

function ComposerPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-composer-card">
      <span>Type — open ?user=bob in another tab</span>
      <b>➤</b>
      <small>Enter to send · Shift+Enter for a new line</small>
    </div>
  );
}

function GroupPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-group">
      <strong>Design team</strong>
      <span>♙ 3 members</span>
      <div>
        <i>AL</i>
        <i>BO</i>
        <i>CA</i>
      </div>
    </div>
  );
}

function ModerationPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-moderation">
      <strong>Moderation queue</strong>
      <span>Review reports and resolve them with typed actions.</span>
      <b>Review</b>
    </div>
  );
}

function MediaPreview() {
  return (
    <div className="chatpack-preview chatpack-preview-media">
      <span>＋</span>
      <strong>Attach files</strong>
      <small>Drop files here</small>
    </div>
  );
}

function PrimitivePreview({ name }: { name: string }) {
  return (
    <div className="chatpack-preview chatpack-preview-primitive">
      <span className="chatpack-avatar">BO</span>
      <div>
        <strong>{name === "User avatar" ? "Bob" : "I'll check the latest pass"}</strong>
        <small>
          05:08 PM · <i>✓✓</i>
        </small>
      </div>
    </div>
  );
}
