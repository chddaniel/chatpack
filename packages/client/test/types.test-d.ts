import { createChatClient } from "../src";
import {
  createChatClient as createReactChatClient,
  useMessageSearch,
  type MessageSearchHookResult,
} from "../src/react";
import { presenceClient, typingClient } from "../src/plugins";

const client = createChatClient({ plugins: [typingClient(), presenceClient()] });
client.conversations.createGroup({ name: "Project", userIds: ["alice", "bob"] });
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

const reactClient = createReactChatClient();
reactClient.useMessageSearch({ query: "whole words", limit: 20 }).loadMore();

function SearchView(): MessageSearchHookResult {
  return useMessageSearch(client, { query: "whole words", limit: 20 });
}

void SearchView;
