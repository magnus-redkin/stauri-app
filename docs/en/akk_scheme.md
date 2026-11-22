# The ACC scheme: Author — Channel — Comments

Stauri does NOT use the Community → Channel scheme in its interface. It is a
poor fit.

This document records the interface scheme "Author → Channel → Comments"
(ACC) and how it maps onto what `status-go` offers **without forking** the
backend.

Complements `architecture.md` (layer boundaries) and
`providers_and_dapps.md` (embedding external data).

## 0. State as of 2026-11-09

The scheme is implemented in its main parts and is being verified live with
scenarios A–E (News, by request, Issues, 1-1, links) and Z (contacts and 1-1).
What exists in the code:

| Part | Where | State |
|---|---|---|
| `responseTo` on send, `isReply()` | `status/messaging.ts` | Done |
| Feed: posts and replies separately | `sections/chat/ChatMain.svelte` | Done: replies nested under the post with a `↳` sign |
| Comment screen for a post | `sections/chat/CommentsPage.svelte` | Done: opens from "Comments (N)", sends with `responseTo` |
| Right to post and to comment | `status/channelRights.ts` | Done: `canRecord(kind, role)`, `canComment(canPost)` |
| Three kinds of channel (news / request / issues) | `status/channelKind.ts` | Done: the kind is stored as a prefix in the description |
| Channel creation | `sections/chat/CreateChannelPanel.svelte`, `CreateChannelForm.svelte` | Done: on the right, description up to 140 bytes |
| Join requests: accept / decline | `ChatMain.svelte`, `status/akk.ts` | Done for the owner |
| Incoming contact: Accept / Reject | `ChatMain.svelte`, `chatsStore` (`acceptRequestAndOpen`, `rejectRequest`) | Done |
| Contact invite (QR, key) | `sections/chat/ContactInvitePanel.svelte` | Partly done: key and QR; the `status.app/u/…` link awaits the payload format |
| Entering a foreign invite (channel / contact) | `sections/chat/JoinInvitePanel.svelte`, `joinByInput` | Done |
| Channel link (the "⋯" menu, "Copy link") | `status/invite.ts`, `ChatMain.svelte` | Done, verified against a real SIM invite |
| Comment counter | — | No, and per §9.3 the decision is to show the fact, not the number |
| Moving to threads | — | Waits for the flag upstream (§13, item 5) |

There is no separate `CommentsPanel` component: the comment screen is
`CommentsPage.svelte`. The channel list is no longer stored locally: it is
built from `active` in status-go, and local subscriptions were removed.

## 1. The goal and the constraint

| | |
|---|---|
| **We want** | The user sees a channel as a feed of the author's posts and can comment on each post |
| **Hard constraint** | Do not fork `status-go` |
| **Why the constraint** | A fork means permanent maintenance and grounds for objections from the Status/Logos authors |
| **Note** | Interacting with `Community` under the hood does not get in the way: the user does not see it |

The scheme must survive the move to Logos-core: the less it leans on
status-go specifics, the cheaper the migration.

## 2. Why not threads

In Status comments are threads, and the mechanism exists:

```go
type Thread struct {
	ThreadID        string `json:"threadId"`
	ChatID          string `json:"chatId"`
	ParentMessageID string `json:"parentMessageId"`
	MessagesCount   uint
}
```

But in `status-backend` they are **disabled**, and it is not a setting but the
build:

```go
// pkg/services/ext/service.go — the full list of messenger options
options := []protocol.Option{
	protocol.WithPushNotifications(),
	protocol.WithDatabase(appDb),
	...
}
// WithThreads() is absent
```

The `WithThreads()` function is declared in `messenger_config.go` and **is not
called anywhere** in the repository.

The danger is not that threads do not work, but how exactly they do not work:

```go
// messenger.go, sendChatMessage
if !m.featureFlags.Threads {
	message.ThreadId = nil          // ← silently overwritten
} else if message.GetThreadId() != "" { ... }
```

The send would return `ok`, and the message would land in the general flow.
To the user it would look like "the comment was sent but did not appear".

**Conclusion:** threads are a goal for the future (when the flag is enabled
upstream), not a means for today.

## 3. What we use instead: `responseTo`

In `common.Message` there is a field that works without flags:

```go
// Message.UnmarshalJSON accepts it directly:
ResponseTo string `json:"responseTo"`
...
m.ResponseTo = aux.ResponseTo
```

The only check on send:

```go
// messenger.go
if len(message.ResponseTo) != 0 {
	exists, err := m.persistence.MessagesExist([]string{message.ResponseTo})
	if exists[message.ResponseTo] == false {
		return nil, ErrInvalidResponseTo
	}
}
```

`MessagesExist` is `SELECT id FROM user_messages WHERE id IN (...)`, **with no
chat filter**. So it is enough that the parent message is in our database;
belonging to a channel is not checked.

That is enough: a comment is an ordinary message with `responseTo` pointing at
a channel post.

| Property | threads | `responseTo` |
|---|---|---|
| Requires a flag | yes | **no** |
| Requires a fork | yes | **no** |
| Participant count | yes | no |
| Channel thread list | `ChatThreads` | no RPC |
| Metadata (name, counts) | `Thread` | no |
| Finding replies | — | SQL only (`MessagesByResponseTo`, no RPC) |

## 4. Key consequence: replies are visible in the general flow

A reply is an ordinary row in `user_messages` with the same `local_chat_id`.
The channel message query **does not filter** by `response_to`:

```go
// message_persistence.go, MessageByChatID
WHERE NOT(m1.hide) AND m1.local_chat_id = ? ...
```

The only filter for "nesting" concerns `thread_id`, and it is explicitly
disabled when threads are off:

> *If threads are disabled, then we are backwards compatible and messages in
> threads are treated as normal messages, so we don't filter them out.*

**So: a comment arrives both in the channel feed and in the comment panel.**

This is not a defect of `status-go` but a consequence of a comment being
technically an ordinary message. Hence two mandatory interface rules:

1. **The channel feed hides messages with `responseTo`.** Filtering on the
   client: `messages.filter(m => !m.responseTo)`.
2. **The comment panel shows only them.** `messages.filter(m => m.responseTo === parentId)`.

Both rules are client-side, because there is no server way to get "replies
only" over RPC. This is the deliberate price of not forking.

## 5. Interface data model

```ts
/** A channel post: a message without responseTo. */
interface ChannelPost {
  id: string;
  chatId: string;
  from: string;
  text: string;
  timestamp: number;
  /** Whether the post has comments. */
  commentCount: number;
  isOwn: boolean;
}

/** A comment: a message with responseTo = parent. */
interface Comment {
  id: string;
  parentId: string;
  from: string;
  text: string;
  timestamp: number;
  isOwn: boolean;
}

/** The state of a channel feed. */
interface ChannelState {
  chatId: string;
  posts: ChannelPost[];
  /** Comments by parent; the key is the post id. */
  comments: SvelteMap<string, Comment[]>;
  /** The open comment panel (null — the panel is closed). */
  openFor: string | null;
  cursor: string;
  canPost: boolean;
}
```

We keep `comments` as a map, not a single array: the panel may open on
different posts, and switching should not reload everything.

## 6. Screens

### 6.1. Left column "Chat"

```
┌────────────────────────────────┐
│ Chat          [👤] [💬] [✎]    │  ← invite · enter invite · new channel
│ ┌────────────────────────────┐ │
│ │ 🔍 Search    │ │  ← always visible, in a frame; clicking the magnifier focuses
│ └────────────────────────────┘ │
│ ◇ news-channel     │
│ ! Incoming contact      │  ← request: Accept / Reject on the right
│ ◇ request-channel · Logos         │
└────────────────────────────────┘
```

The icons open the **right** panel, not the left: the left stays a list.
Search filters the list by channel name, community name and id. An invite
entered in the search field is **not parsed**: the link is pasted into the
right "Join by invite" panel.

### 6.2. Right panel

The mode is stored in `chatsState.rightPanel`: `chat`, `contactInvite`,
`joinInvite`, `newChannel`. Selecting a chat in the list returns to `chat`.

| Mode | What it shows | Component |
|---|---|---|
| `chat` | the selected chat's conversation, or "Select a chat" | `ChatMain.svelte` |
| `contactInvite` | QR and profile key (`zQ3…`) to add a contact | `ContactInvitePanel.svelte` |
| `joinInvite` | a field for a `status.app/cc/…` or `status.app/u/…` link | `JoinInvitePanel.svelte` |
| `newChannel` | the channel creation form, description as a textarea | `CreateChannelPanel.svelte` |

For an incoming request (`active: false`, `lastMessage.contactRequestState = 1`)
`ChatMain` shows an "Accept / Reject" screen instead of the conversation.
Accept accepts the contact and opens the chat; Reject declines and returns the
panel to "Select a chat".

### 6.3. Channel branch

```
┌─ Channel "Logos / general" ─────────────────────┐
│       │
│  ◯ Author      12:04        │
│  Publishing the week's summary…   │
│  💬 7 comments            ← click      │
││
│  ◯ Author      09:31        │
│  The new build is in the release.       │
│  💬 2 comments          │
└─────────────────────────────────────────────────┘
        ↓ click on "7 comments"
┌─ Comments ───────────────────────────────────────┐
│  ◯ Author      12:04        │
│  Publishing the week's summary…   │
│  ─────────────────────────────────────────      │
│  ◯ Alice      12:07 │
│  Thanks!           │
│  ◯ Bob        12:09        │
│  And when is the next one?        │
│       │
│  [ Write a comment… ] │
└─────────────────────────────────────────────────┘
```

The comment screen is **inside** the right area (`CommentsPage.svelte`), not a
pop-up window: it is part of the same chat. The post input field is visible
only to those allowed to post (`canRecord`); a member the channel allows may
comment (`canComment`).

## 7. Rights: two different questions

They must not be mixed, or the interface will promise what the backend will not
deliver.

**Question 1 — may one post to the channel.** Computed by the backend:

```go
func (o *Community) CanPost(pk, chatID, messageType) (bool, error) {
	hasAccessToChat := o.CanView(pk, chatID)
	if !hasAccessToChat { return false, nil }
	if o.IsPrivilegedMember(pk) { return true, nil }
	member := chat.Members[crypto.PubkeyToHex(pk)]
	if member == nil && channelHasPermissions(...) { return false, nil }
	...
}
```

The result already arrives in `CommunityChat.canPost` and in `ChatItem.canPost`.
**Clicking a message does not grant rights** — it either opens the comments or
shows why it cannot.

**Question 2 — may one reply to a post.** There is no separate right: it is the
same `canPost`. A reply is an ordinary message.

So the interface logic is simple:

```
canPost == false  →  the panel opens (read), there is no input field,
                     with an explanation
canPost == true   →  the panel opens, the input field is active
```

A separate mechanism "gain rights by clicking" does not exist and is not
needed. Without the right, only joining the community or a token grants it.

## 8. Flow: from invitation to comment

```
1. A link arrives
   status.app/c#<key>  ──►  a community, not a channel
                             (channel invites are not issued separately)

2. Viewing
   spectateCommunity(id)
   → channels are readable, canPost = false

3. Joining
   requestToJoinCommunity
   → choosing addresses + password (status-go does the signing)
   → result: a request; acceptance arrives as a signal

4. After joining
   canPost = true → the input field appears

5. Clicking a post
   → the comments of that post (responseTo filter)
   → input is available if canPost

6. Sending a comment
   sendChatMessage(chatId, text, communityId, responseTo = parentId)
```

**A note on channels:** a channel deep link inside a community looks like
`status-app://cc/<channel>#<community>`, but it leads to an already known
community. Status public channels (`#status`) are standalone and have no
invites, only a name.

## 9. What changes in the code

| File | Change | State |
|---|---|---|
| `status/messaging.ts` | `responseTo` in `sendChatMessage`; `isReply()`; `declineContactRequest`, `markChatRead` | **done** |
| `status/channelKind.ts`, `channelRights.ts` | channel kind and the right to post / comment | **done** |
| `status/akk.ts` | channel creation by kind, owner requests, `sendComment` | **done** |
| `status/invite.ts` | channel link from the UUID and community key | **done** |
| `status/contactState.ts` | incoming contact request by status-go fields | **done** |
| `status/openedChannels.ts` | channels of foreign communities opened by link | **done** |
| `stores/chatsStore.svelte.ts` | list from `active`, `rightPanel`, Accept/Reject, mark-read | **done** |
| `sections/chat/ChatMain.svelte` | posts and replies; the request screen; right-panel branches | **done** |
| `sections/chat/CommentsPage.svelte` | the comment screen for a post | **done** |
| `sections/chat/ChatLeft.svelte` | icons and search in the header | **done** |
| `sections/chat/ContactInvitePanel.svelte` | QR and key for inviting | **done**, the `/u/` link — no |
| `sections/chat/JoinInvitePanel.svelte` | entering a foreign invite | **done** |
| `sections/chat/CreateChannelPanel.svelte` | creating a channel on the right | **done** |

The `chatsStore` changes: it is the single source of the list (from `active`
in status-go). Local channel subscriptions (`chatSubscriptions`) were removed:
they produced duplicates and "resurrected" deleted channels.

Dropping a separate comment panel is kept: the `CommentsPage` screen is the
same nested model, opened over the whole right area by clicking "Comments".

### 9.1. The send signature

```ts
export async function sendChatMessage(
  port: number,
  chatId: string,
  text: string,
  communityId = '',
  responseTo = ''          // an empty string — an ordinary message
): Promise<any>
```

The `responseTo` field goes at the top level of the object — next to `chatId`,
as `Message.UnmarshalJSON` expects.

### 9.2. Separating messages

One function, so the rule lives in one place:

```ts
/**
 * A comment is a message with a non-empty responseTo.
 *
 * status-go does not distinguish them at the channel level: a reply lies in the
 * same table and arrives in the general list (MessageByChatID does not filter
 * response_to). So the separation is our duty, and it must be done exactly here.
 */
export function isReply(msg: { responseTo?: string }): boolean {
  return !!msg.responseTo && msg.responseTo.length > 0;
}
```

### 9.3. Counting comments

There is no server counter. We count on the client from the history already
loaded:

- on loading a page of messages, group the replies by `responseTo`;
- show the counter only for loaded pages;
- if the history is long, the counter will be incomplete — **that must be shown
  honestly**: "7 comments" may mean "7 out of the loaded ones".

An alternative is to show the fact rather than the number: "Has comments".
Less lying for the same UX.

**Decision:** in the first step we show the fact, not the number. We will
enable the number if a way to get it exactly appears.

## 10. On the two-channel fantasy

A proposal: the author creates two channels — a "main" one and a service one —
and the comments physically live in the second but look like comments on the
first.

**It will work**, and here is an honest assessment.

What the gain is:

- replies do not get into the general flow — nobody sees them in the main
  channel;
- the rights can be distributed differently: in the main channel — only the
  author may post, in the service channel — everyone;
- visually it is exactly ACC.

The price:

| Problem | Essence |
|---|---|
| Double delivery | the user is subscribed to two channels instead of one |
| The "comment → post" link | still goes through `responseTo`: the link is by message id, not by channel |
| History | the order of messages between channels is not guaranteed |
| Rights | `canPost` must be checked for the service channel, but shown for the main one |
| Visibility | the service channel must be hidden from the chat list — but there it is real |
| Creation | the author has to create two channels and link them; on error — garbage in the list |
| Logos-core | in a flat channel model this linkup will not survive the migration |

The main point: **the "comment → post" link already goes through
`responseTo`**, not through the channel. The second channel solves no problem
the first does not, except one — "do not show replies in the main flow".

And that problem is solved by one line of client filter:

```ts
messages.filter(m => !isReply(m))
```

**Decision: a second channel is not needed.** If it later turns out that
replies should have different rights than posts, we will come back to it.
For now it is an extra entity in the model that would have to be hidden from
the user and that would break on the move to Logos-core.

## 11. Boundaries of the scheme

What the scheme does **not** do and why:

| Not doing | Reason |
|---|---|
| Nested comments (a comment on a comment) | `responseTo` allows it technically, but the panel becomes a tree. The first step is a flat list |
| Comment notifications | requires parsing `response_to` in signals — a separate task |
| Editing and deleting | exist in status-go but are not part of ACC |
| "The author separately" ordering | the author is `msg.from`, filtered on the client; we do not introduce a separate "author channel" |
| Comment rights separate from post rights | see §10 |

## 12. Verified on a live backend

The scheme rested on three assumptions. All three were checked with calls
against a running `status-backend` (channel `#status`, 2026-11-04).

| # | Assumption | Result |
|---|---|---|
| 1 | `responseTo` is accepted without a feature flag | **confirmed** — the message was saved with `responseTo` = the parent id |
| 2 | The reply arrives in the channel's general list | **confirmed** — `chatMessages` returned it alongside the others |
| 3 | A link to a message from another chat is not rejected | **confirmed** — a send into another channel with `responseTo` at a `#status` post went through |

The third was the only one capable of narrowing the scheme to "comments only
inside one channel". It did not narrow: `MessagesExist` really does not filter
by chat.

### One more fact from the check

`wakuext_sendChatMessage` returns in `result.messages` **both the new reply and
the parent message**. So after sending a comment the panel can be updated from
the reply, without a separate history request.

### A note on inactive chats

Sending to an **inactive** chat (`active: false`, e.g. a 1-1 conversation that
was left) creates no message and returns no error: the reply simply has no new
message. For checks this matters — the interface must recognise the branch "no
error, but no result either" itself, by the absence of its own id in the
reply.

## 13. Implementation order

1. `responseTo` in `sendChatMessage` + `isReply()`. **Done.**
2. Live check §12: a reply to our own message in `#status`.
   **Done** (2026-11-04).
3. Feed separation: posts and replies. **Done.**
4. Comment screen with an input field and rights checking. **Done**
   (`CommentsPage.svelte`).
5. Requests and channels: creation by kind, accepting/declining requests by the
   owner. **Done.**
6. Entering by link: channel, community, contact (`status.app/u/…`). **Done**,
   the contact is verified live (scenario Z).
7. Contact invite: QR and the `status.app/u/<payload>#<key>` link.
   **Partly**: the key and QR exist; the payload format awaits confirmation.
8. Open question: channel history. No decision chosen.
9. Moving to threads when the flag appears upstream: one field changes
   (`responseTo` → `threadId`) and the history query. The place to edit is
   known: `isReply()` and `sendChatMessage` are the only ones that know about
   the field.
