# chat audit (2026-11-19)

Why the picture in picture window showed a group's `#general` under the stream `testingstuff`, and why your own stream's chat was missing from the player while you watched someone else. What every chat surface uses, the bugs found, and what changed.

## the surfaces

| surface | where | state | transport |
| --- | --- | --- | --- |
| stream chat, watch page | `WatchPage` → `ChatSlot` → `ChatPanel name=<stream>` | `chat-atoms.ts` | ws `/chat/<name>` |
| stream chat, go live page | `LivePage` → `ChatSlot` → `ChatPanel name=<settled name> owner` | `chat-atoms.ts` | ws `/chat/<name>`, hello with the streamer's grant |
| group channels | `ServerRoom` → `ChatPanel name=<server> channel` | `chat-atoms.ts` (the channel on screen) + its shelf (the others); `room-atoms.ts` seeds it from `GET /api/groups/:g/messages` and moves it on `group` facts | ws `/chat/<server>/*`, every channel on one socket |
| corner player (watch) | `MiniPlayer` `WatchCorner` → `CornerPlayer` → `ChatPanel embedded` | `chat-atoms.ts` | ws `/chat/<name>` |
| corner player (your stream) | `MiniPlayer` `LiveCorner` → `CornerPlayer` → `ChatPanel embedded owner` | `chat-atoms.ts` | ws `/chat/<name>` |
| popped out window (Document Picture-in-Picture) | the same `CornerPlayer` portalled into `documentPictureInPicture.window` (`infra/popout.ts`) | `chat-atoms.ts` (the same jotai store: the window is the same JS realm) | as the corner |
| direct messages | `FriendChat` | `dm-atoms.ts`: threads by peer name (`dmThreadsAtom`), drafts and pictures per thread in the component | http to send and read, the events socket (`dm` frames) to hear |
| history, search, a speaker's lines | `ChatPanel`, `ChatSearch`, `ProfilePopup` | `chat-atoms.ts` | http `/chat/<room>/before`, `/search`, `/by/<name>`, `/around/<id>` |

## bugs found

1. **One global chat for the whole page.** `chat-atoms.ts` held a single `session` and one set of atoms (`chatLinesAtom`, `chatDraftAtom`, `chatCountAtom`, the shelf, the scroll plan…). Every `ChatPanel` read those same atoms and called `openChat` / `openServerChat`, which closed whatever room was open. With the corner player's chat open over a group page, the group's `openServerChat` took the one session, and the corner's panel drew the group's lines (the screenshot: `#general` under `testingstuff`). Whichever panel mounted last won, and a line typed in one box went to the other's room.
2. **The player's chat was switched off on any page with a chat.** Since state was global, `MiniPlayer` disabled the corner's chat button on every `/watch/*` and `/live` page (`hasOwnChat`, "this page has its own chat"). Live and watching someone else, your own stream's chat was unavailable in the player and in its popped out window.
3. **Closing a panel closed the room for everyone.** `leaveChat` closed the one session 100ms after any panel unmounted, and a different room opening closed the leaving one at once (`settleLeave`), so a page change could drop the socket another surface was using.
4. **A server's channel facts reconnected every chat.** `room-atoms.ts` called the global `reconnectChat()` when a channel went away; with the old single session that was fine, but with two rooms it would also have reconnected the corner's stream.
5. **"their lines here" asked whichever room was open.** The profile popup's `showSpeaker` used the one session, so with two chats it could load the speaker's lines from the wrong room.
6. **A duplicate line could be drawn.** The live tail only checked the last line's id against an incoming one, so a line that arrived both from the api's seed and the socket's `since` replay, out of order, could be drawn twice. Now it checks the whole tail and the shelf by id.

The api side was checked and needed no change: a stream's room is `chat:<name>` and a channel's is `chat:<server>/<channel>` (stream names cannot hold a `/`), the per-speaker buckets are per room, `/chat/<server>/*` tags every line with its channel, and the history routes cannot collide with a channel since `before`, `search`, `by` and `around` are reserved channel names (`groups.rs` `RESERVED_CHANNELS`). Direct messages were already per thread.

## what changed

- `chat-atoms.ts` is a `ChatRoom` class, one instance per room, kept by key in a map (`chatRoomFor(name, server)`): a stream's name, or `<server>/*`. Each instance has its own atoms (lines, loaded, count, draft, pictures, notice, phase, wait, hits, pinned, guest, channel), its own socket and reconnect timer, its own bucket, its own shelf and scroll plan.
- Panels `join` a room and get its leave back. The room is reference counted: it closes `LEAVE_MS` (100ms) after its last panel went, and only that room. Two panels on one room share its one socket and one list of lines, so nothing is fetched or drawn twice. While any panel in the room holds the streamer's grant, the socket says hello as the streamer; that panel going says hello again without it.
- `ChatPanel` takes its room from `chatRoomFor(name, channel !== undefined)` and reads only that room's atoms. `#chat` now carries `data-room` (the room key) for the tests.
- `CornerPlayer` / `MiniPlayer`: `pageHasChat` is gone. The player's chat is always the stream in the player. It is disabled only where the page's own chat is that very room (`pageChatIsOurs`: your stream on `/live`, the watched stream on its own watch page), and the player is not shown there anyway. In the popped out window over that same page, it is a guest of the page's room, as before.
- `room-atoms.ts` addresses the server's room by name (`serverChat`, `findServerChat`): seeding, following, dropping, renaming and reconnecting touch that server's socket alone.
- `reconnectChat()` (a new nick, a login, groups worn) and `refaceLines()` (a new picture) go to every open room.
- The profile popup's `lines` is the key of the room the line was in, and "their lines here" asks that room.
- `chatChannelAtom` (the notifications' "channel on screen") is written by the server room on screen and cleared when that room closes.

## left as is

- Each room is a socket of its own. With the player's chat open over another chat that is two chat sockets; one socket carrying several rooms (`join` frames) is in `transition.md`.
- The corner's panel and the page's panel use the same element ids (`#chat`, `#chat-text`, …), as the spec lists them; with both on one page, the tests scope by the player (`#live-pip-player #chat`) or by `data-room`.

## picture in picture stopped the stream

Going picture in picture while live (the preview's button, the corner player, its pop out window, the tab left with the stream up) must never stop or restart the publish. The peer, the tracks, the model's worker and the mixer are module handles in `publish-atoms.ts`, owned by no component; only stop (the sources panel's button), the corner's × after its yes, a failure, or the tab really closing end them. What could end or lose a stream on that path, and what changed:

- **`beforeunload` stopped the stream.** `goLive` listened for `pagehide` and `beforeunload`, both calling `stopOnLeave` (beacon, then `stopLive`). `beforeunload` fires for leaves that never happen (a `mailto:` or an app's link, a leave another listener cancels), and the stream was stopped with the page still there. Now `pagehide` alone, and `stopOnLeave` acts only when the event is this page's own document: the popped out window hiding or closing (its own `pagehide`, `infra/popout.ts`) is never a stop.
- **A crash in the player replaced the whole app.** The router's one `errorElement` (`CrashPage`) is on the shell, so a throw in a corner player, or in the player portalled into its window, unmounted every page, and the crash page's reload then ended the stream. Each corner player is now caught on its own (`MiniPlayer` `CornerCatch`): it reports the crash, draws nothing, is tried again on the next page, and the stream goes on.
- **A closed window could be rendered into.** `CornerPlayer` portalled into `out.win.document.body` until the window's `pagehide` cleared `out`; a render in between (the live corner renders every second, with the stats) portalled into a torn down document, which throws (the crash above). A closed window is no longer the player's home (`!out.win.closed`), and an effect lets it go.
- **Leaving `/live` asked only the phase's word.** `leaveLivePage` kept the stream when `isPublishingAtom` said so; it now also keeps it while the peer or the owner (the go-live grant) is there, so a page going away never ends a stream that is up.

Checked and left as is: `LivePage`'s unmount is `leaveLivePage`, never `stopLive`; no component cleanup stops a track or closes the peer (the `<video>`s only drop their `srcObject`, the mic chips close their own analysers, never the mixer); the model's worker and its camera go only through `endLive` or a model that broke; a shared screen's track `ended` stops that screen, not the stream; closing the popped out window only brings the player back to the page (`openPopout`'s `onClose` → `setOut(null)`). Not reproduced in a browser here (no playwright, no headless chrome in this session): the fixes are from reading the code.
