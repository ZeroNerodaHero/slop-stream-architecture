# frontend/src/infra

the header comment of each file in `frontend/src/infra`, moved here when the source lost its comments (`.cursor/rules/no-comments.mdc`). what a file does now is the code; these say what it was written for and the reasons behind it at the time of the move, so check them against the code before you trust a detail.

## `about.ts`

The about tab's page (docs/about.md), the parts that are not the tab itself (About.tsx):
the rules for a link, and the cleaning of a text block's html. A text
block is a fragment of a few tags, never html from a string: the tab parses it and draws each
tag it allows as its element. A picture, a clip and a track are objects the owner put up;
the page names them by id. Scripts have no door: there is no block that takes one.

## `api.ts`

The json api behind /api. Same origin, so the dev server and caddy both forward it.

## `atoms/auth-atoms.ts`

Who is logged in. The cookie is httponly, so the page never sees it; it asks
/api/me once and remembers the answer. Nobody has to log in: without an
account you are the name in `nickAtom` (localstorage), see chat-atoms.

## `atoms/calendar-atoms.ts`

The calendar on the watch page (docs/calendar.md): a week of the name's sessions from
`GET /api/streamers/:name/sessions?from=&to=`, as rows; `Calendar.tsx` turns them into blocks
in the viewer's zone. A week runs monday to sunday: `page` 0 is the one with today in it, 1
the week before, and so on. The rows are asked again when the stream on screen starts or
ends, so the open block appears and closes with no reload, and when the grid is opened on
another name or another page. The profile popup (ProfilePopup.tsx) has the same grid for
whoever it is about, over a page that may be showing its own: each has its own rows
(`CalendarScope`), so the one does not blank the other.

## `atoms/chat-atoms.ts`

The text chat next to a stream, and in a server's channels. A room is one websocket: at
/chat/<name> for a stream, or /chat/<server>/* for a whole server, every channel's lines on
the one socket, each tagged with its channel, so the room page switches channels on screen
(`showChannel`) and opens nothing. The lines of the channels not on screen wait on a shelf;
the api's last lines of every channel seed it (`seedChannels`), and the socket is told the
newest id it has per channel (`since`) so nothing falls between the two. See docs/chat.md,
docs/groups.md and docs/chat-audit.md.

Every room is a `ChatRoom` of its own, kept by its key (`chatRoomFor`): a stream's name, or
`<server>/*`. Its lines, its draft, its socket, its shelf and its scroll are its own, so two
panels on two rooms at once (the corner player's stream over a group's channel, your own
stream's chat in the player while you watch someone else) each show their own lines and send
to their own room. Panels join and leave a room (`join` hands back the leave); the room
closes `LEAVE_MS` after its last panel went, and two panels on one room share it: one socket,
one list of lines, no line twice.

## `atoms/chat-layout-atoms.ts`

Where this browser left its chat windows, kept over a refresh: the stream chat's window
(ChatSlot.tsx, the layout setting's "window") and the friends' chat window (FriendChat.tsx),
each where it was dragged and how big, and whether the friends' chat was on screen and which
tab it showed. One versioned key; nothing said in a chat is in it. Whatever localstorage
holds is read through a check: a box that is not four finite numbers is the default place,
and the windows pull a kept box back on screen themselves (`fitted`), so a smaller window
than the one it was left in never hides a chat.

## `atoms/crop-atoms.ts`

The crop dialog's one request: the file somebody picked and what the upload wants of it.
`cropPicture` is the whole exchange for the actions that save a picture: it opens the dialog
(CropDialog.tsx, mounted by the Shell) and answers with the bytes to send, or null when the
dialog was closed without. The action sets its own `saving` after that, so the status line
stays quiet while the dialog is open.

## `atoms/dm-atoms.ts`

Direct messages with friends (docs/dms.md): the threads the login is in, their lines, and
the window that shows them (FriendChat.tsx). The api keeps the lines; this module asks for
them a page at a time, sends new ones over http, hears them come back on the events socket
(to every device of both sides, so a line sent here lands in your other tabs too), and
counts what is new. One window, a tab per friend down its side; it hides and shows with
its tabs kept, and with no tab shown it offers the friends to pick from. A thread is
searched over http too (`searchDm`), and a hit is put in view by loading the pages back to
it (`openDmLine`). Same shape as the other atom modules: atoms for what renders, action
functions for every transition.

## `atoms/follow-atoms.ts`

Who the login follows (docs/follows.md), and the panel in the corner that shows them. The
list comes from `GET /api/following` each time the panel opens, so the words beside the names
(streaming, online, offline) are fresh; a follow or an unfollow changes the list at once and
asks again behind it. Search goes to `GET /api/search` a beat after the last letter
(`setSearchQuery`), and what it answered is kept a short while, so letters it has seen, or
more letters than an answer that was complete, are shown without asking. What the person
card needs past what its row holds (a chat line's speaker: the word and the status) comes
from `GET /api/streamers/:name` when a card shows, kept a short while per name. A guest
follows too, in this browser alone (the last part of this file): the names are kept here,
localstorage like the nick, and told to nobody, and how each of them is comes from that
same profile read, a name each.

## `atoms/groups-atoms.ts`

Groups: the list from `GET /api/groups`, which of them are mine, and the actions on them.
See docs/groups.md. The user modal's groups tab edits them and the profile tab shows mine;
the sidebar lists the ones I am in as servers (`GET /api/explore`'s `yours`, which has each
one's picture and who in it is live) and its search box finds those and the public ones
(`discover`). The chat needs little from here: the server puts each
speaker's badges on the line itself, and a badge only reads the freshest picture version
from these (`groupIconsAtom`). Same shape as the other atom modules: atoms for what
renders, action functions to change it.

## `atoms/home-atoms.ts`

The home list (docs/status.md). One `GET /api/streams` when the page arrives: the home
service's snapshot, in its order (first on, first shown). Then the facts over the events
socket, under `watch *`: `live` puts a card at the end, `ended` takes one out, `viewers`
moves a count. Nothing polls. The two pulls behind the push: the socket opening (or coming
back) while the page is up takes the snapshot again, since the facts of a gap are gone, and
an ask that failed is asked again, later each time, the watch page's shape. Frames that land
while a snapshot is in flight are held and applied on top of it, so a stream that started
in that window is neither lost nor doubled. Same shape as the other atom modules: atoms for
what renders, module handles, action functions.

## `atoms/inspector-atoms.ts`

The messages inspector: the frames this browser sent and received, on all three sockets
(`/events`, `/chat/<name>`, `/ws`), the last 1000 in a ring, with a filter. The ring is a
module handle (frames.ts), never an atom; `framesTickAtom` says it changed, once per frame
of animation, and the panel reads the ring directly. Where the events worker holds the
socket it also holds the ring (every tab sees the same 1000, a tab opened later gets
history); this tab mirrors it. Without a worker the ring here is the one. See docs/status.md.

## `atoms/notification-atoms.ts`

The login's inbox (docs/notifications.md): the last 30 things that happened to them, as the
api keeps them. Someone they follow went live, someone followed them, a friend wrote, someone
wrote in a channel of a group they are in. The list comes from `GET /api/notifications` once
the login is known; new rows arrive on the events socket (to every device of the login, so a
phone and a laptop hold the same list); opening the bell's list reads everything on it, here
and through the api, which tells the other devices. A channel's row is read by having the
channel on screen, the way a friend's is by the thread. Which kinds are kept is the account's,
saved through the api from the user modal's notifications tab. A click reads the server's
settings and changes only that kind, so a save from another page is not turned back on. Same
shape as the other atom modules: atoms for what renders, action functions for every transition.

## `atoms/presence-atoms.ts`

Presence: the word next to a name (`offline`, `online`, `dnd`, `streaming`) and the choice
behind mine (`online`, `dnd`, `invisible`). The words arrive on the events socket
(events.ts): `me` for my own, `presence` for the names the page watches. The choice goes
out as an http PUT; its answer comes back on the socket to every tab and device, so nothing
here guesses. Same shape as the other atom modules. See docs/status.md.

## `atoms/profile-atoms.ts`

My profile, from anywhere: the status (one line beside the name; `bio` on the wire, since
`status` is the presence choice's word, docs/status.md), the picture, what my stream's page
shows while I am not live (the offline picture and the line under the word), and where
else to find me (the links, docs/socials.md), edited on my own page under the player. All saved under the name I am, which is the login, else the nick
lowercased (every valid nick is a valid name). The user modal's profile tab edits the
first three and the corner panel shows the picture. Its own atoms, not the go live page's
(that page keeps only the thumbnails and the picture library, under the name it streams as,
and resets them when it is left). The links are bridged to the watch page below, so my own
page follows a save.

## `atoms/profile-popup-atoms.ts`

The profile popup (ProfilePopup.tsx, docs/follows.md): somebody's page over the page you are
on, opened by a click on them in a group's roster or on their name in a chat, while this
browser's setting says so (settings.profilePopup, on unless turned off). Who it is about
lives here: one person at a time, and nobody while it is closed. Same shape as the user
modal's atoms.

## `atoms/publish-atoms.ts`

Going live from the browser camera. State lives in atoms; the peer connection, socket and
timers are plain module handles because nothing renders from them. Every state change goes
through an action function here, so cause and effect sit in one place (no reactive effects).

## `atoms/room-atoms.ts`

A group's room (docs/groups.md), loaded once and then kept by the socket. Arriving on
`/groups/<server>` asks the api twice, in parallel: the room (`GET /api/groups/:group`:
the group, the channels, who is live, the roster and the bans this login may see) and the
last lines of every channel (`GET .../messages`, into the chat's shelf). From then on the
events socket is the only source: `watch group:<server>` brings a `group` frame for every
change (someone joined, a channel was added, a role was given, a member went live…) and
this module patches the room in place. Changing channels asks nothing of anyone. The one
pull behind the push: a change about the login itself (its own membership, powers or roles)
asks the room again, since what it may see depends on them; and the socket coming back
after a gap does too, since the facts of the gap are gone. Same shape as the other atom
modules: atoms for what renders, module handles, action functions.

## `atoms/settings-atoms.ts`

The preferences this browser keeps (localstorage, like the nick): where the chat sits on a
page, whether its window is see-through, where it sits on the corner player, which corner the you panel sits in, which lists
it shows in what order and which of them are folded, whether the bots' lines show, whether
the lines wear faces, the shape of the lines in a chat with a friend, whether a link asks
before it opens, whether a click on somebody shows them in a popup, the theme, and how big
the pages are. Not part of the account: a laptop and a phone can each have their own. Same
shape as the other atom modules: atoms for what renders, action functions to change it. The
modal that edits them is user-modal-atoms.ts.

## `atoms/user-modal-atoms.ts`

The user modal: the gear at the end of your line in the corner panel opens it on the tab it
was last left on (appearance, the first of this browser's tabs, the first time); a few links
around the site open it on a tab of theirs (sign up or log in on security, a guest's picture
with no name yet on profile, the gear in the notifications list on notifications, a list
switched off in the sidebar on sidebar). Which tab is open lives here, and is kept in
localstorage, so a close or a reload comes back to it.

## `atoms/voice-video.ts`

Cameras and screens in a voice call (docs/voice.md, video/src/voice.rs). The call itself is
voice-atoms.ts's: it hands this module its peer and a way to send once the join is answered
(`startVideo`), every seats frame (`videoSeats`), an answer that is not the join's
(`takeVideoAnswer`), and the end (`stopVideo`).

The page is always the one that offers, one offer at a time, so it never crosses one from
the voice server. Each offer names this page's sending video mids, `{sdp, video: {mid:
'camera' | 'screen'}}`. A camera or a screen turned on is a sendonly VP8 line (a new one the
first time, the old one after), turned off the same line inactive, and both are offered. The
others' pictures come on recvonly lines: a seats frame lists what each seat shows and the mid
that carries it, and when it lists more pictures than there are lines, lines are added and
offered. Caps are on the sender: a camera 640x360 at 24fps and 600 kbps, a screen up to
1920x1080 at 15fps and 1.5 Mbps.

## `atoms/watch-atoms.ts`

Watching one stream. Same shape as publish-atoms: atoms for what renders, module handles
for the peer connection and socket, action functions for every transition.

`start` runs the handshake beside the grant, not after it. When there is a warm peer (the
press's, the boot script's, or one made at the start because the name is not known to be
offline), `handshake` sends `role: watch` and the offer on its `/ws` socket as soon as the
offer is set, while `POST /api/streams/<name>/watch` is still out. This opens nothing: video's
watch path never asks the api or looks at a grant, it checks the name and whether the room is
live and answers `{"error":"not live"}` otherwise; the grant was never what let a viewer in.
Until the grant lands nothing of the stream reaches the page: tracks, socket frames and
connection states are held, the phase stays `loading`, and no timer runs. Then:

- the grant failed (no answer, an error): everything the handshake opened is closed and the
  page retries later, as before;
- renamed, or not live: closed, and the rename or `not live yet`;
- live: `connecting` (once the setup has gone out), the held tracks and frames are applied,
  the state is caught up, and the 10s no-video timer starts when the answer is in. A
  handshake that already failed before the grant (video said `not live` because the
  publisher was not attached yet, the socket closed) or a grant naming another socket path
  than `/ws` is closed and run again on a fresh peer, the old sequential way.

A name known to be offline makes no peer, and the handshake starts after a live grant.
Every attempt checks `attempt` and its own `pc` after each wait, so a stale one does
nothing, and `teardown` closes the warm socket and peer it was using.

## `atoms/welcome-atoms.ts`

The chat welcome (docs/chat.md): a line from the bot `Eques` at the top of a stream's chat
when it is opened, drawn on that viewer's screen alone (ChatPanel.tsx `WelcomeLine`). Never
sent, never in the room's lines: no history, no unread, no mention. The streamer keeps whether
it is said and the words (`welcome_on`, `welcome` on the profile read and the watch grant;
`PUT /api/streamers/:name/welcome`); a viewer may turn every stream's off for this browser.

## `calendar.ts`

The calendar's arithmetic (docs/calendar.md): the api's session rows become blocks (sessions
merged across a gap under five minutes: one stream whose connection dropped, as long as the
whole, gap and all), blocks become pieces on day columns (cut at the viewer's midnights), and
a week of blocks becomes the line `streamed tuesday and thursday around 8pm`. Pure; the
viewer's clock and zone come in as arguments, and nothing here reads one.

## `emotes.ts`

A group's custom emotes (docs/chat.md "emotes"): discord's server emoji. In a line's words an
emote is the token `<:name:id>`; the pages draw it as its picture (`Emote.tsx`), and the box
shows it as `:name:` (`encodeEmotes` writes the token back on the way out). Who may use one is
the api's to say (emotes.rs `settle`): a token the sender may not use comes back as plain
`:name:`, and one whose emote is gone is drawn as `:name:` too.

Two lists live here. `myEmotesAtom`: every emote of every group the login is in (`GET
/api/emotes/mine`), for the composer's `:` list and the reaction picker. And what any token on
screen is (`useEmotes`): asked of `GET /api/emotes?ids=` in batches as lines arrive, so a line
from someone in a group the reader is not in still shows its emote and its group.

## `events.ts`

The events socket, from a tab's side (docs/status.md, docs/transition.md). One `/events`
socket per browser, held in the events worker (events.worker.ts) and reached over a
MessagePort; where there is no SharedWorker (chrome on android, samsung internet, the
android webview) a plain socket for this tab, same frames, same atoms. Either way this
module is the one place the pages touch it: `startEvents()` once per page load, the verbs
(`watchPresence`, `unwatchPresence`, `reconnectEvents`), and `onEvents` for a module that
wants the frames (watch-atoms for `live`). The frames themselves land in presence-atoms.

## `events.worker.ts`

The events worker: one per browser (a SharedWorker), holding the one `/events` socket for
every tab of the site. Tabs attach with a MessagePort and talk in the envelope of frames.ts;
frames go through unchanged. The worker owns the hello, the reconnect, the watches (counted
per tab, so one tab leaving does not unwatch a name another still shows), the last word of
every watched name (a tab attaching late gets it at once), and the inspector's ring. See
docs/status.md. No store, no react, no dom in here: frames.ts only (a worker has no
localStorage, and the atoms would reach for it the moment they load).

## `face-wasm.classic.ts`

The face reader's wasm for a classic worker, which is what a build makes of
`face.worker.ts` (vite's `worker.format` is `iife`): the loader is a script for
`importScripts`. Its own module so only one of the two 11 mb binaries is in a build
(`face.ts` picks this one or `face-wasm.module.ts`).

## `face-wasm.module.ts`

The face reader's wasm for a module worker, which is what the dev server makes of
`face.worker.ts`: `importScripts` throws there, and the reader falls back to `import()`,
which wants the es module loader. See `face-wasm.classic.ts`.

## `face-wire.ts`

What the page and the face worker say to each other (docs/vtuber.md). Types only: the worker
imports this and not `face.ts`, so nothing of the page ends up in its bundle.

The face reader, as the streamer is told: `starting` while it loads, `on` with a face in
view, `lost` with none, `off` when it did not load (the model still breathes and blinks).

## `face.ts`

A model as a camera (docs/vtuber.md): a model file's bytes and a camera's track in, one video
track out, whose picture is the model moving with the face in front of that camera. The
track is what `publish-atoms.ts` puts where the camera's picture would go; the camera's own
track is handed to the face reader here. Its picture is shown in one place, the rigging panel
on the streamer's own page (`readerCameraAtom`), and sent nowhere.

The work is the face worker's (`face.worker.ts`). This file starts it, and connects it to
the camera and to a track, one of two ways:

- `worker`: the camera's frames go straight into the worker and its drawn frames straight
  into a track (chrome's and edge's insertable streams). The page is not in the loop, so a
  hidden tab changes nothing.
- `page`: this page reads each camera frame and posts it in, and paints each drawn frame the
  worker posts back onto a canvas whose capture is the track. Every browser can; it stops
  while the tab is hidden, because a hidden page gets no animation frames.

`localStorage['settings.modelPath'] = 'page'` asks for the second on a browser that has the
first (to look at it, and for the test).

## `face.worker.ts`

The face worker (docs/vtuber.md): the camera's frames in, the model's frames out, and the
page nowhere in between. It reads the face in each camera frame (mediapipe's face
landmarker, in wasm), turns the reading into a pose (`pose.ts`), and thirty times a second
moves the model toward that pose and draws it (`model-draw.ts`).

In a worker because a page that is hidden gets no animation frames and one timer a second,
and the streamer is in another tab, or a game, the whole time. A worker's timers and a
camera's frames are not held back. Where the browser hands a track's frames to a worker and
makes a track of a worker's frames (`frames` and `sink` on `start`), the whole loop is in
here and a hidden tab changes nothing. Where it cannot, the page posts each camera frame in
and gets each drawn frame back, and that way stops when the page does.

The reading and the drawing are not tied: the model is drawn on a timer, from whatever pose
the last reading left, so a slow reader makes a face that follows late, never a picture
that stutters, and a camera with no face in it still leaves a model that breathes.

This worker talks to this site and to nobody else (`fetch` and `XMLHttpRequest` below). The
reader is pinned to the last version that sends nothing to its maker; this is the second
lock on that door.

## `fbx.ts`

An `.fbx` before it is drawn (docs/vtuber.md): what `vrm.ts` is to a glb. An fbx is a tree of
named records, written as bytes or as text. This walks the few records it needs and never a
mesh: what is in the file by name and which of those are bones, which way is up in it, and
whether the pictures it wears are inside it. Pure: no dom, no three. The page asks before a
file is kept (`model-file.ts`); the worker asks which way to stand the model up.

## `frames.ts`

The frames on the `/events` socket (docs/status.md), the envelope between a tab and the
events worker, and the ring the inspector keeps. Pure: no store, no react, no dom, so the
worker bundle can import it too.

## `mic-level.ts`

How loud the mic is, many times a second, for a bar that moves with the voice. An
`AnalyserNode` on the camera's audio track: the samples are read off it and never played
(nothing is wired to the speakers), and the peer connection sending that same track is none
the wiser. The once-a-second level in `stream-stats.ts` is for the numbers; this is for the eye.

 Below this the bar is empty: room noise, a mic left open in a quiet room. 0 dB, a full-scale signal, is the top.

## `mixer.ts`

The sound that leaves the page (docs/audio.md): the mic, and any sound added later, each
with a fader, a mute and a meter, summed into one track. That track is what the audio sender
holds for the whole stream, so a source coming or going changes the mix without anyone
renegotiating and without the sender's track ever changing. It opens on the go live page as
soon as there is a mic, before going live, and go live sends the same mixer's track.

One AudioContext for every source (mic-level.ts opens one per reader, right for one meter and
wrong for several). Nothing here reaches `ctx.destination`: the streamer hears the tab from
the tab and themselves in the room, and every preview on the page is muted. Web audio keeps
rendering while the tab is hidden, which is where the streamer is once they share another tab.

## `model-adopt.ts`

A model that is no vrm, made one in memory (docs/vtuber.md). A glb or an fbx is a mesh on a
skeleton and no more: which bone is the head, which way the model faces, how big it is and
what its morphs mean are for whoever opens it to work out. This works them out once, as the
file is loaded, and hands back the `VRM` the drawer and the rig already know: its bones by
their names (`model-bones.ts`), the model stood up, turned to the camera and made a person's
height, and the expressions a vrm would have, out of its morphs' names (`model-rig.ts`).
After this nothing knows what kind of file it was.

What a vrm has and this cannot make: hair and clothes that swing (spring bones), eyes that
turn (a look-at), and a licence.

## `model-bones.ts`

A model's bones, found by their names (docs/vtuber.md). A vrm says which of its bones is the
head. No other file does: a glb or an fbx has a skeleton whose bones are named the way the
tool that made it names them, and the head is the one that is called a head. This reads the
names: mixamo's (`mixamorig:Head`), ready player me's and unity's (`Head`, `LeftArm`),
vroid's (`J_Bip_C_Head`), a biped's (`Bip001 Head`), unreal's (`head`, `upperarm_l`), mmd's
(`頭`, `左腕`).

Pure: names and who is whose parent in, places in that list out. The page asks whether a
file has a head at all, before the file is kept (`model-file.ts`); the worker asks which
bones to move (`model-adopt.ts`). One rule for both, so a file the page lets in is one the
worker finds a head in.

 What is said of a file with nothing called a head, by the page at the door and by the worker should one get past it.

## `model-draw.ts`

The model, drawn (docs/vtuber.md): one scene with one model in it, framed as a bust, and one
`draw(pose, dt)` that moves it toward a pose and paints a frame onto the canvas it was given.
The head, the neck and the lean are here; the face is `model-rig.ts`'s; the file, whatever
kind it is, is `model-load.ts`'s, which hands over a vrm either way. It runs in the face
worker, on an `OffscreenCanvas`; nothing in here knows about a camera, a track or the page.
`three` and `@pixiv/three-vrm` are imported by these and by nothing a page loads, so they are
in the worker's bundle and in no page's.

A vrm 0.x model faces the other way from a 1.0 one. `VRMUtils.rotateVRM0` turns the whole
model round, which leaves its bones' own x and z pointing the other way: every turn about
those two is flipped for a 0.x model (`side`).

## `model-file.ts`

A model's file before it is drawn (docs/vtuber.md): which kind it is, whether this page can
make a model of it, and what it says of itself for its card. The kind is read off the file's
first bytes, never its name: a `.vrm` and a `.glb` are both a glb (`vrm.ts`), an `.fbx` is an
fbx (`fbx.ts`). Pure: no dom, no three. The page asks before a file is kept or handed on, so
one that would not be drawn is refused at the door, in words; the worker asks only which
loader the bytes are for.

A vrm says where its head is and which shapes are its blink. A glb with no vrm in it, and an
fbx, do not: they are models by the names of their bones (`model-bones.ts`), and one with
nothing called a head has nothing a face could move.

## `model-load.ts`

A model's file made a model of, in the face worker (docs/vtuber.md): the bytes of a `.vrm`,
a `.glb` or an `.fbx` in, a `VRM` out, and every morph it has by name. A vrm is a vrm as it
comes. The other two are loaded as what they are and made one (`model-adopt.ts`).

Everything a model needs is inside its file, and nothing is fetched from anywhere else: the
loaders may open the file's own blobs and no other address.

## `model-rig.ts`

A model's face, and what moves it (docs/vtuber.md). A vrm promises a few expressions by name:
five vowels, the blinks, five moods. Most models carry more than that, under names of their
own. This looks once at what one model has and settles how the face reader's 52 scores reach
it (`RigInfo.kind`):

- `arkit`: the model has the reader's own 52 as expressions ("perfect sync"). Each score goes
  to the expression of its name and nothing is worked out.
- `shapes`: its face mesh has the brows, the eyes and a smile as morphs of their own, as every
  model out of vroid studio does. Expressions are made of those here, so brows follow brows
  and a smile is a smile, beside the vowels and the blinks.
- `presets`: only what a vrm promises. The vowels and the blinks; a clear smile is `happy`
  and brows drawn hard down are `angry`, as whole faces.
- `none`: no expression of its moves anything. The head still turns.

`buildRig` runs before `VRMUtils.combineMorphs`: that keeps only the morphs some expression
uses, and the ones made here have to be among them.

A model that is no vrm (a glb, an fbx) promises nothing: it has morphs, named the way the
tool that made it names them. `expressionsOf` gives it the expressions a vrm would have, out
of those names, and from there it is a model like any other.

## `model-store.ts`

The models this browser keeps (docs/vtuber.md), in indexeddb: the streamer's own model files,
so the one they wore last is there on the next visit and the picker can offer the others
again, and the site's demo models as they were downloaded, so one worn before opens at once,
with nothing to download and with the server away. Nothing here goes to the api: a person's
own model stays on their machine.

Indexeddb and not the browser's http cache (which drops a big file whenever it likes), the
cache api (made for answers to requests, which a picked file is not) or the private file
system (no better for a file read whole, and missing in some private windows): it takes a
file as it is, it is in every browser, and the three share one quota anyway.

Three stores, so listing the models never reads their megabytes. `meta` is the streamer's
own: a name, an author, a size and a small picture each. `demos` is the demo models kept: an
id, which version of the file, a size, when it was last worn. `files` is the bytes of both:
under the number `meta` gave for their own, under `demo:<id>` for a demo. A browser with no
indexeddb (some private windows) keeps nothing: every function here then answers as an empty
shelf would, and the model still works for the visit.

 One kept model, without its bytes.

## `names.ts`

 Stream names: lowercase letters, digits, _ and -. 1 to 32 chars. Same rule as api and video.

## `oauth.ts`

The login providers the pages know by name (docs/accounts.md). The api's list
(api/src/oauth.rs `PROVIDERS`) is the one that counts: `GET /api/oauth/providers` says which
are turned on, and a slug missing here still gets a button, with its slug for a label and a
plain icon (OAuthButtons.tsx `ProviderIcon`). A new provider: its entry in the api's list,
then a label here and an icon there.

## `password.ts`

The rule for a new password (signup, change), the api's `clean_new_password` in
api/src/auth.rs: nfkc first, then 8 to 128 characters with at least one number and one
symbol (anything not a letter, a number or a space). Logging in asks none of this, so a
password made before the rule still works. The api checks it again: this is the inline hint.

## `people-search.ts`

A people search of a box's own: the sidebar's way (follow-atoms.ts `setSearchQuery`) without
its atoms, so a box elsewhere (the mod tab's) does not drive the sidebar. The letters are
cleaned as the api cleans them (`cleanSearch`), `GET /api/search` is asked a beat after the
last one, and each answer is kept a short while: letters seen, or more letters than an answer
that was complete, are shown without asking. People only; groups are the sidebar's.

## `picture.ts`

A picture before it goes anywhere. Every picture the pages put up (the profile picture, a
thumbnail, the offline picture, a picture for the scene) is picked as a file and then cut in
the crop dialog (CropDialog.tsx): a rectangle of the shape the upload wants sits over the
picture, is moved and scaled by hand, and what is inside it is what goes up, drawn at the
size the api wants and encoded here. So the api never decodes an image (profile.rs); it
checks the first bytes and the size, and puts the bytes in the bucket as they came.

This file is the geometry (the rectangle, kept inside the picture and in shape) and the cut
itself. The dialog draws it; `crop-atoms.ts` opens it.

 A rectangle of the picture, in the picture's own pixels.

## `popout.ts`

The popped out player: the corner player in an always-on-top window of its own, over every
other app, through the document picture in picture api. The window is a blank same-origin
document this page controls (no scripts of its own: react portals the player into it, and
the atoms, the chat socket and the peer stay here), dressed as this page: its stylesheets,
and the theme's variables and the size on its <html>, kept in step with the appearance
settings while it is open. Chrome, edge and firefox 151+ have the api; safari does not, and there the button is
not shown at all (`canPopOut`). The window never outlives the page: a load or a closed tab
closes it. A click opens it (the pop out button), and so does the tab being left while a
broadcast is up, where the browser says so (`onTabLeft`).

## `pose.ts`

A face as numbers (docs/vtuber.md): where the head is turned and what the face is doing,
worked out from what the face reader says about one camera frame. Pure arithmetic: no dom,
no three, no reader. The face worker feeds it readings and hands the pose to the drawing.

From a reading to a pose: the resting face is taken off (the first second of a face, or
`rest()`), left and right are swapped for a mirror, each score is stretched to 0..1 (a real
blink or an open jaw does not score all the way to 1) and every number is smoothed.

`moodOf` is what a pose says beyond the mouth and the blinks, as the few things this reader
can be believed on: the brows up or down, a smile, eyes wide.

 The 52 scores, in arkit's order: the names a face reader and a "perfect sync" model share.

## `prefetch.ts`

Page data asked for on the press, not on the page (docs/spec.md "Prefetch on press"). A
`pointerdown` on a way to `/`, `/watch/<name>` or `/groups/<server>` asks the api for what
that page asks first as it mounts, ~100-200ms before the click and the route get there; the
page's loader takes the answer instead of asking again. One path for every way there: a link
is seen by the one listener on the document (`installPrefetch`), a button that navigates by
hand spreads `usePrefetchOnPointerDown(path)` on itself.

Each page's module says what its page asks (`onPrefetch`), beside its own loader, so the two
cannot drift. Reads: a press that goes nowhere costs one answer that is dropped after
`PREFETCH_TTL_MS`, and a `watch` of the page's topic on the events socket for as long. The
watch page's prefetcher also warms its peer and video socket for as long, sending nothing
(watch-atoms.ts `warmOnPress`). Nothing written.

The topic is watched from the press, as the page would from its mount, so what the socket
says about it between the answer and the mount is not lost: a fact that makes the answer
old drops it (`drop`, the page asks again), or is kept for the page to apply on top of it
(`hold`, home's list). The socket coming back after a gap drops everything, and so does
another login: the answer was someone else's.

## `preview.ts`

Muted camera previews for the home page, a group's live members and the profile popup,
beside the one watched stream.

The watch page and the corner player share one connection (`watch-atoms`). These are
their own peers, so a card playing on home does not hang up a stream in the corner.
Each one asks for a single video section and no audio: video gives that watcher the
camera, which is the 720 picture the streamer sends. There is no smaller encode.
Each goes to video as `preview: true`, so it is not a viewer and spends none of this
address's watcher share (relay.ts); a hidden tab holds none at all.

## `relay.ts`

The video server speaks one websocket at /ws. One message each way to set up:
  we send   {"role":"publish"|"watch","name":"...","sdp":"<offer>"}
            (a publisher adds the go-live "session" and "token"; video checks them with the api.
             home's muted camera previews add "preview":true: video serves them like watchers but
             counts none as a viewer and caps them apart, 12 per address in all, past which it
             answers "too many previews from your address")
  we get    {"sdp":"<answer>"}  or  {"error":"..."}
The socket stays open for the whole session. Closing it hangs up. On the open socket:
  a publisher sends  {"slots":[{"slot":0,"kind":"camera"},{"slot":1,"kind":"screen","label":"screen"}],
                      "scene":{"layers":[{"id":"s1","kind":"screen","slot":1,"x":0,"y":0,"w":1,"h":1},
                                         {"id":"cam","kind":"camera","slot":0,"x":0.73,"y":0.714,"w":0.25,"h":0.25}]}}
                     whenever what it shows changes: its video slots that are live, see `SlotInfo`
                     (slot 0 is named only while the camera is on: a mic-only stream leaves it
                     out and its section quiet), and how its frame is laid out, see `Scene`
  a watcher gets     {"event":"slots","slots":[...],"scene":{...}}  right after the answer and on every change
                     (no `scene` from a publisher that never sent one: the dummy, an older page)
                     {"event":"ended"}  when the publisher leaves
  both get           {"event":"viewers","viewers":3}  how many addresses are receiving it, on change, at most 1/s

A publisher's offer carries every video section it may ever send on: the camera and
SCREEN_SLOTS empty ones for screens, filled and emptied later with `replaceTrack`, which
renegotiates nothing. A watcher's offer asks for as many, so a screen shared mid-stream
reaches everyone already watching. Which slot is what travels in the slots frames: packets
alone cannot say (an empty section still gets padding, and a muted track never says so).

## `report.ts`

The pages report their own failures to the api: one json line to POST /api/errors, same
origin, through sendBeacon so it still goes out of a page that is dying. The api keeps
them in the debug database and /admin shows them. See docs/debugging.md.

Nothing in here may break the page: every call swallows its own errors, the same message
is not sent twice inside 30s, and each kind has a budget per page load (20, `api` 5),
then that kind goes quiet. A render loop, or an api that is down for an hour, otherwise
produces thousands and crowds out the one crash that mattered.

## `scene.ts`

The streamer's frame as numbers (docs/screen.md): the sources they can put on the stream,
the boxes those sit in, and the arithmetic of moving, resizing and arranging them. Pure: no
atoms, no store, no dom. publish-atoms.ts owns the state and calls in here; SceneView draws
the result on both sides from the same fractions.

## `socials.ts`

Where else to find them (docs/socials.md): the links under the player, as one document the
owner replaces whole, like the bio. How the links sit (`row` or `grid`), how big, and the
links themselves: a kind from a fixed list (the icon the page draws), an http(s) url, and
words of theirs if they gave any. The api checks every field at the door; the page checks
again before it draws, whoever wrote the row (about.md's rule), and reads a kind it does not
know as `web`, so a link saved through a newer api still shows. Pure: no atoms, no dom.

## `stream-stats.ts`

How the stream is doing, read from the peer connection once a second. Two pipes, read apart:
a watcher measures the copy arriving here (loss, freezes, the picture on screen); a publisher
measures the upload to the box (the encoder's limit, the loss the box reports). The box copies
one picture, so a watcher's bad link never shows up on the publisher's numbers.

The peer connection stays a module handle. `startSampler` is the timer; it writes a snapshot
the page renders, and nothing renders from the connection itself.

## `theme.ts`

The palette: the twelve colours globals.css holds as rgb triplets (so tailwind can add alpha),
the presets, and the derivation that turns a background and an accent of someone's choosing
into all twelve, readable. No dependencies. Mixing is done in oklab (a straight line there is
what "a little toward the text" should mean; near-greys have no hue to arc through), contrast
is wcag 2's ratio. Every function is total: channels clamp to 0..255, NaN falls to 0.

## `voice-gate-worklet.js`

The noise gate for voice activity (voice-atoms.ts): the mic passes while it is louder than
`threshold` (a linear RMS, 0 for always open) and for HOLD_S after, then fades out, so the
room between words is silence. Runs in the audio thread: a hidden tab's timers slow down, this
does not. Plain js: an AudioWorklet module is loaded by its url, not bundled.

 How long the gate stays open after the last loud block: the tail of a word, a breath between two.

## `voice-offer.ts`

The voice offer, cut down to what the voice server can use, before it goes in the join frame
or a later offer (voice-video.ts).

The browser gathers candidates for every m-line of the offer (16 audio ones, docs/voice.md),
not one set: until the answer agrees to BUNDLE each m-line has its own ports. The voice server
bundles everything onto m-line 0's transport, so the candidates of the others are never tried.
They are most of the offer, and a phone has many networks (wifi, cellular, VPNs, each IPv4 and
IPv6, each udp and tcp): an iPhone's audio-only offer measured 72 KB, a call's video lines (up
to 32 more) can triple that, and the voice server refuses anything over 128 KB with `bad offer`
(MAX_SDP_BYTES in video/src/voice.rs). So: m-line 0 keeps its udp candidates, tcp ones go (the
voice server only listens on udp), and the others keep none.

Only the string sent changes: the browser's own local description is left as it was.

## `vrm.ts`

A `.vrm` or a `.glb` before it is drawn (docs/vtuber.md). A vrm is a glb: a 12 byte header, a
json chunk, a binary chunk. This reads the header and the json chunk, never a mesh: does
everything it needs sit inside the file, is it a vrm, what does it call itself, who made it
and who may wear it; and for a glb that is no vrm, what its bones are called, which is all
that says where its head is. Pure: no dom, no three, so the page asks it before a file goes
anywhere (`model-file.ts`).

The one thing it refuses that a loader would take: a buffer or a picture named by `uri`.
Whoever draws such a file fetches from wherever it points, and a model from a random download
should not get to call home from the streamer's browser.

## `watch-beat.ts`

The watch page's beat for the streamer's stats (docs/analytics.md): while the video plays, a
`POST /api/streams/<name>/watching` at once and then every minute, and one more with
`leave=1` when it stops (the page left, the stream ended, the tab closed). The api turns them
into one stretch of watching per viewer. A login is counted by its cookie; anyone else by a
random id this browser keeps (`ANON_KEY`), sent every time, so a guest is one viewer however
many streams and visits. The viewer counts are not this: those are video's own.

## `watch-perf.ts`

The watch page's startup, phase by phase, on the performance timeline (docs/debugging.md
"Watch startup timings"). Every phase is a `watch:<phase>` mark and a `watch:<phase>`
measure from the origin: the press on a link when the attempt took the peer warmed on it,
the boot when the attempt took index.html's boot script's (a stream's page loaded straight), else
the attempt's start. Phases: press or boot, start, peer, offer, ws-open, setup-sent, grant,
answer, ice-connected, first-frame (the setup goes out beside the grant, so setup-sent and
often answer come before grant).

With `?perfdebug=1` in the url, or `localStorage.perfdebug = '1'`, the first frame prints the
whole line with `console.debug`. Off, the marks are still there for devtools' performance
panel and for watchperf's measure script; nothing is printed.

## `atoms/voice-atoms.ts`

Being in a voice channel (docs/voice.md). One call at a time, for the whole tab: a join asks
the api for a grant (`POST /api/groups/:group/voice/:channel/join`), opens `/voice`, and its
first frame is `{role: 'voice', grant, sdp}` with an offer of 1 sendrecv mic and 15 recvonly
audio m-lines (video/src/voice.rs). The voice server answers `{sdp}` or `{error}`, then
`{event: 'seats', seats: [{seat, user, line}]}` on every join and leave: `line` is the m-line
that person is heard on. Who is in which channel is the room's (`voice` in room-atoms.ts,
kept by the `voice` and `voice_left` facts); this module is only this tab's own call, and who
is speaking in it, from each m-line's `audioLevel` (getStats). Same shape as the other atom
modules: atoms for what renders, module handles, action functions. Cameras and screens in the
call are voice-video.ts's, on this call's peer. The devices a call uses (the mic, the
speakers, the camera) are picked in the user modal's voice tab and kept in this browser; they
are after the call. Last is the mic itself: one stream, shared by the call and the tab's
meter, through voice isolation and the noise gate, and push to talk.

`export const RETRY_MS`: The waits before each retry of a join that failed: 5 tries in all, the first at once.

`export interface VoiceCall`: This tab's call. `joining` from the click to the answer, through every retry and the waits
between them; `linked` once the audio itself is through (the peer connected over udp), which
can lag the answer or never come; `failed` once the last try failed, still on its server and
channel (the greyed seat and the dialog say why) until it is left or tried again. `error` is
the last try's reason, '' for none; `retry` is which retry this is, 0 for the first try.

`export const voiceSeatsAtom`: Who sits where in the room, as the last seats frame said. Your own seat is not in it.

`export const voiceSpeakingAtom`: The names speaking now, your own among them while your mic is.

`export const voiceMutedAtom`: Your mic is off: the track is still there, sending silence.

`export const voiceDeafAtom`: You hear nobody, and your mic is off with it.

`export const voiceStatsAtom`: How the call is getting through, every STATS_MS while connected; null before the first read and while idle.

`export function retryable`: Whether a join that failed with `error` is worth another try. `status` is the grant's http status when the api answered with one: a 4xx is final.

`export function retryDelay`: The wait before retry number `retry` (1 for the first), or null once the tries are spent.

`export function dropped`: Whether a call that was through ended by its connection breaking (the socket, or the peer's ice), not by a word from the voice server such as a moderator's `disconnected`.

`export function leaveVoice`: Out of the call, if in one, and no more retries. Clicked (leave, cancel, dismiss), another channel, or the page going away.

`export async function joinVoice`: Into `channel` of `server`: a run of up to 5 tries (fail). Already in it or joining it: nothing;
failed there, a fresh run. In another: out of that one first.

`export interface StatsEntry`: The fields of a getStats report this file reads: every report is one of these, most of them absent.

`export interface VoiceStats`: How the call is getting through. A number is null when the browser did not say or there is no window yet (the first read).

`export interface StatsSample`: The running counters a delta is taken against.

`export function voiceQuality`: Good under 100ms and 1% lost, ok under 250ms and 5%, else poor. Null when neither is known. An unknown one counts as fine.

`export function kbps`: `now - was` per ms, as kbps from bytes; null without both, or when the counter went back (a new path).

`export function lossPercent`: The share of packets lost over a window, %, from the running lost and received counters; null when no packet was due.

`export function readStats`: One getStats report read as the call's quality, with the deltas against `was` (the last
read's counters). The path is the transport's selected candidate pair (chrome, safari), else
the pair marked `selected` or nominated and succeeded (firefox).

`export const DEFAULT_DEVICE`: A pick that is no device in particular: the browser's own (the system's).

`export interface VoiceDevices`: What is plugged in, by kind. The browser names its devices (and gives their ids) only once
one of that kind was allowed: until then a list is empty and its `named` is false, and a
kept pick cannot be told from a gone one.

`export const SINK_SUPPORTED`: The browser can send a player's sound to a device of its choosing. Not safari, not an older firefox: the speakers are the system's there.

`export const voiceInputAtom`: Read: the device each is on now.

`export function setVoiceInput`: A call on now follows a new mic and new speakers at once.

`export function setVoiceCamera`: A call's camera, when on, moves to the new one at once.

`export async function openVoiceCamera`: The camera for the tab's preview and for a call (voice-video.ts, with its size and rate).

`export async function refreshVoiceDevices`: The devices plugged in now, into `voiceDevicesAtom`; a call on moves off one that went. Watches for plugging from its first call on.

`export async function playTestTone`: A short beep through the speakers picked. On the mic's audio context while there is one (the tab's meter has it open): a new context is a slow thing to make.

`export const voiceModeAtom`: Voice activity (the gate decides) or push to talk (a held key does).

`export const voiceGateAtom`: The gate's threshold, dB, on the meter's scale: FLOOR_DB (the meter's empty end) is always open.

`export const voicePttKeyAtom`: Push to talk's key, a `KeyboardEvent.code`.

`export const voicePttDelayAtom`: How long the mic stays open after the key comes up, ms: the end of the last word.

`export const voicePttHeldAtom`: Push to talk's key is down (or was, within its delay), in a call.

`export const voiceIsolationFailedAtom`: Voice isolation is on and could not be had (no web audio, the wasm would not load): the mic goes out with the browser's own cleaning.

`export function keyName`: A key's `code` as it is printed on the key.

`export async function holdVoiceMic`: Opens the mic, or joins whoever has it open. Throws as getUserMedia does; then it is not held.

`export function releaseVoiceMic`: Lets go of the mic; the last to let go puts it down.

`export function readVoiceMicLevel`: The mic's loudness for the tab's meter, 0..1 on the meter's scale; 0 with no mic or no web audio.

`export function gateFraction`: The gate's threshold on the meter's 0..1 scale: 0 is always open.

## `atoms/voice-state.ts`

`export interface HeardLevel`: Your own level for someone you hear: their volume in percent (0 to HEARD_MAX, 100 as they come) and whether you muted them for yourself. Nobody else hears a difference.

`export const HEARD_MAX`: The loudest a person can be turned up to, in percent: past 100 is a gain, which an element's volume cannot do.

`export const voiceHeardAtom`: Read: the kept levels, by user id, what was kept checked over.

`export const voiceUidsAtom`: Name to user id for whoever is in voice in the room on the page (room-atoms.ts keeps it): the seats frame says names, the levels are kept by id.

`export function heardLevelOf`: `uid`'s level: what is kept, else the default.

`export function setHeardLevel`: Moves `uid`'s level, live on the call. Back at the default, nothing is kept for them.

## `chat-video.ts`

`export interface ChatVideo`: A video on a chat line (chat_videos.rs, docs/chat.md "videos"): its id and its poster's, a chat picture the api drew from a frame.

`export const MAX_VIDEO_BYTES`: The api's ceilings (chat_videos.rs `MAX_BYTES`, `MAX_MS`): checked here first, so a refusal costs no upload. The api measures the file itself and has the last word.

`export function videoSrc`: Where a chat video is played from, by the id `POST /api/chat-videos` handed back.

`export function posterSrc`: The poster, a chat picture like any other (ChatPanel's `pictureSrc`, which this module does not import: the panel imports it).

`export function isVideoFile`: A video the picker, a paste or a drop brought: anything the browser calls one, or a video's file name.

`export async function readVideo`: A video file checked before it goes up: an mp4 or a webm, 10 mb and 30 seconds at most, read
by a `<video>` of the page's own, so a file the api would refuse is not sent. The api reads the
length again itself and draws the poster (chat_videos.rs). Throws the words the box shows.

`export function videoOf`: A line's `video` as the wire has it: both ids, or none (an older api leaves it off).
