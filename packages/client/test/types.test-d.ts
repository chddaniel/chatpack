import { createChatClient } from "../src";
import {
  createChatClient as createReactChatClient,
  useMessageSearch,
  type MessageSearchHookResult,
} from "../src/react";
import { presenceClient, typingClient } from "../src/plugins";

const client = createChatClient({ plugins: [typingClient(), presenceClient()] });
client.conversations.createGroup({ name: "Project", userIds: ["alice", "bob"] });
client.conversations.createGroup({
  name: "Public project",
  visibility: "public",
  joinPolicy: "approval",
});
client.conversations.update({ conversationId: "c1", visibility: "public", joinPolicy: "open" });
client.conversations.addParticipants({ conversationId: "c1", userIds: ["carol"] });
client.conversations.removeParticipant({ conversationId: "c1", userId: "carol" });
client.conversations.setParticipantRole({ conversationId: "c1", userId: "alice", role: "admin" });
client.typing.start({ conversationId: "c1" });
client.typing.state.getSnapshot()["c1"];
client.presence.get({ userIds: ["alice"] });
client.presence.state.getSnapshot()["alice"];
client.messages.search({ query: "whole words", limit: 20 });
client.messages.react({ messageId: "m1", emoji: "thumbs-up" });
client.messages.unreact({ messageId: "m1", emoji: "thumbs-up" });
client.invites.create({ conversationId: "c1", requiresApproval: true });
client.invites.list({ conversationId: "c1" });
client.invites.revoke({ conversationId: "c1", code: "invite" });
client.invites.preview({ code: "invite" });
client.invites.accept({ code: "invite", message: "hello" });
client.joinRequests.create({ conversationId: "c1", message: "please" });
client.joinRequests.list({ conversationId: "c1", status: "pending", limit: 10 });
client.joinRequests.resolve({ conversationId: "c1", userId: "bob", decision: "approve" });
client.channels.list({ limit: 10, cursor: "next" });
client.channels.join({ conversationId: "c1", message: "please" });
client.moderation.blockUser({ targetUserId: "bob" });
client.moderation.unblockUser({ targetUserId: "bob" });
client.moderation.listBlockedUsers({ limit: 10, cursor: "next" });
client.moderation.muteConversation({ conversationId: "c1" });
client.moderation.unmuteConversation({ conversationId: "c1" });
client.moderation.listMutedConversations();
client.moderation.report({ targetType: "user", targetId: "bob", reason: "spam" });
client.moderation.listReports({ status: "open", targetType: "user" });
client.moderation.getReport({ reportId: "r1" });
client.moderation.updateReport({ reportId: "r1", status: "resolved", moderatorNote: null });
client.moderation.listBans({ activeOnly: true });
client.moderation.banUser({ targetUserId: "bob", expiresAt: "2030-01-01T00:00:00.000Z" });
client.moderation.unbanUser({ banId: "b1" });

async function narrowInviteResult() {
  const result = await client.invites.accept({ code: "invite" });
  if (result.error === null) {
    if (result.data.status === "joined") {
      result.data.conversation.id;
      result.data.joinRequest;
    } else {
      result.data.conversation;
      result.data.joinRequest.id;
    }
  }
}

void narrowInviteResult;

const reactClient = createReactChatClient();
reactClient.useMessageSearch({ query: "whole words", limit: 20 }).loadMore();

function SearchView(): MessageSearchHookResult {
  return useMessageSearch(client, { query: "whole words", limit: 20 });
}

void SearchView;
