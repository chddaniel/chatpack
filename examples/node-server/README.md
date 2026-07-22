# example-node-server

The smallest possible Chatpack deployment: one file, in-memory storage, and a
header-based demo auth hook — so you can exercise the whole REST API **and the
live SSE stream** with curl.

> Auth here trusts an `x-user-id` header. **Demo only.** In a real app your
> `auth` hook verifies a session or JWT.

## Run

```sh
pnpm install
pnpm --filter example-node-server start
```

## The curl walkthrough (M2 DoD)

```sh
BASE=http://localhost:3000/api/chat

# 1. Requests without auth are rejected
curl -si $BASE/conversations | head -1
# HTTP/1.1 401 Unauthorized

# 2. alice finds-or-creates a conversation with bob
CONV=$(curl -s -X POST $BASE/conversations \
  -H 'x-user-id: alice' -H 'content-type: application/json' \
  -d '{"otherUserId":"bob"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["conversation"]["id"])')
echo "conversation: $CONV"

# 3. alice sends a message
curl -s -X POST $BASE/conversations/$CONV/messages \
  -H 'x-user-id: alice' -H 'content-type: application/json' \
  -d '{"body":"hey bob!"}'

# 4. bob replies
curl -s -X POST $BASE/conversations/$CONV/messages \
  -H 'x-user-id: bob' -H 'content-type: application/json' \
  -d '{"body":"hey alice!"}'

# 5. bob lists the history (newest first)
curl -s $BASE/conversations/$CONV/messages -H 'x-user-id: bob'

# 6. mallory is not a participant — permissions enforced
curl -si $BASE/conversations/$CONV/messages -H 'x-user-id: mallory' | head -1
# HTTP/1.1 403 Forbidden
```

## Live messages over SSE (M3 DoD)

Open **two terminals**.

Terminal 1 — bob listens:

```sh
curl -N http://localhost:3000/api/chat/stream -H 'x-user-id: bob'
```

Terminal 2 — alice sends:

```sh
BASE=http://localhost:3000/api/chat
CONV=$(curl -s -X POST $BASE/conversations \
  -H 'x-user-id: alice' -H 'content-type: application/json' \
  -d '{"otherUserId":"bob"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["conversation"]["id"])')

curl -s -X POST $BASE/conversations/$CONV/messages \
  -H 'x-user-id: alice' -H 'content-type: application/json' \
  -d '{"body":"hello, live!"}'
```

Terminal 1 prints the event the moment it happens:

```
id: <conversationId>:1
event: message.created
data: {"type":"message.created","conversationId":"…","message":{…,"body":"hello, live!"}}
```

Edits arrive as `message.updated`, soft-deletes as `message.deleted`.

### Reconnect gap-fill

Every event's `id` is `conversationId:seq`. If the connection drops, reconnect
with the last id you saw and the server replays what you missed from storage
before resuming live delivery — no lost messages:

```sh
# Ctrl-C the listener, send a few messages as alice, then:
curl -N http://localhost:3000/api/chat/stream \
  -H 'x-user-id: bob' -H "Last-Event-ID: $CONV:1"
# → replays every message after seq 1, then goes live
```

(Browser `EventSource` sends the `Last-Event-ID` header automatically on
reconnect; `?lastEventId=` works as a query fallback.)

## All routes

| Method | Path                          | Action                  |
| ------ | ----------------------------- | ----------------------- |
| POST   | `/conversations`              | find-or-create a 1:1 DM |
| GET    | `/conversations`              | list my conversations   |
| GET    | `/conversations/:id`          | fetch one conversation  |
| POST   | `/conversations/:id/messages` | send a message          |
| GET    | `/conversations/:id/messages` | list messages           |
| POST   | `/conversations/:id/read`     | update my last-read     |
| PATCH  | `/messages/:id`               | edit my message         |
| DELETE | `/messages/:id`               | soft-delete my message  |
| GET    | `/stream`                     | SSE: live events for me |
