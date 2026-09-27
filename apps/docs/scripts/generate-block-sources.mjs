import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import prettier from "prettier";
import ts from "typescript";

const docsRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const uiRoot = path.resolve(docsRoot, "../../packages/ui/src");
const files = [
  "blocks.tsx",
  "gallery.tsx",
  "inputs.tsx",
  "realtime.tsx",
  "groups.tsx",
  "primitives.tsx",
];
const names = [
  "ConversationList",
  "CompactChatList",
  "ConversationHeader",
  "MessageThread",
  "FlatMessageThread",
  "GroupedMessageThread",
  "ChatWindow",
  "InboxLayout",
  "MobileChatSheet",
  "FloatingChatWidget",
  "MessageComposer",
  "ReplyComposer",
  "MentionComposer",
  "MessageActions",
  "ForwardDialog",
  "MessageSearch",
  "QuickReactions",
  "TypingIndicator",
  "TypingDots",
  "ConnectionStatus",
  "PresenceBar",
  "ReadReceipts",
  "MembersList",
  "ParticipantManager",
  "InviteManager",
  "ChannelDirectory",
  "BlockedUsers",
  "ReportDialog",
  "ModerationQueue",
  "AttachmentComposer",
  "AttachmentDropzone",
  "MessageAttachments",
  "ImageBubble",
  "FileBubble",
  "UserAvatar",
  "MessageBubble",
  "Timestamp",
  "PresenceDot",
  "ReadReceiptTicks",
  "ReactionPill",
  "ReplyQuoteBar",
  "EmptyState",
];

const found = new Map();
for (const file of files) {
  const source = readFileSync(path.join(uiRoot, file), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const node of ast.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name) continue;
    if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      continue;
    if (!names.includes(node.name.text)) continue;
    found.set(node.name.text, { file, code: node.getText(ast) });
  }
}

const missing = names.filter((name) => !found.has(name));
if (missing.length > 0) throw new Error(`Missing UI exports: ${missing.join(", ")}`);

const data = Object.fromEntries(names.map((name) => [name, found.get(name)]));
const output = `// Generated from packages/ui/src. Run: node apps/docs/scripts/generate-block-sources.mjs\nexport const blockSources: Record<string, { file: string; code: string }> = ${JSON.stringify(data, null, 2)};\n`;
const target = path.join(docsRoot, "components/block-sources.ts");
writeFileSync(target, await prettier.format(output, { filepath: target }));
