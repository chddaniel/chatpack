import { createChatClient } from "../src";
import { presenceClient, typingClient } from "../src/plugins";

const client = createChatClient({ plugins: [typingClient(), presenceClient()] });
client.typing.start({ conversationId: "c1" });
client.typing.state.getSnapshot()["c1"];
client.presence.get({ userIds: ["alice"] });
client.presence.state.getSnapshot()["alice"];
