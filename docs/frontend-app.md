# frontend/src/app and the other frontend/src files

the header comment of each file in `frontend/src/app` and the loose files in `frontend/src` (`main.tsx`, `router.tsx`, `build.d.ts`, `utils/`), and the doc comment of each export, moved here when the source lost its comments (`.cursor/rules/no-comments.mdc`). the code is the truth; these say what a file was written for at the time of the move, so check a detail against the code before trusting it.

## `frontend/src/app/CrashPage.tsx`

`export function CrashPage`: What a render crash shows instead of react router's default page. The report already
went out through the RouterProvider's onError in main.tsx. No PageFrame here on purpose:
if the header itself is what crashed, this page must not render it again.

## `frontend/src/app/admin/AdminPage.tsx`

`export function AdminPage`: /admin: this droplet's health and the failures its pages reported. For a login in
ADMIN_NAMES; everyone else gets told why not. See docs/debugging.md.

## `frontend/src/app/auth/AuthPage.tsx`

`export function AuthPage`: /login and /signup, kept as links: not a page any more, but the auth dialog (AuthDialog.tsx)
opened over `next` (home without one). The address moves to `next` at once, so a login, a
close or a reload all leave you there.

## `frontend/src/app/auth/OAuthPage.tsx`

`export function OAuthPage`: Where the api sends the browser back after Google or Discord (api/src/oauth.rs):
`?done=<p>` logged in, `?linked=<p>` attached to this account, `?pick=<p>` new here and
picking a name, `?error=<words>` it did not work. Logged in or linked, the page goes back to
where the trip started (a link from the security tab opens it again, showing the new login
and the verified mark). See docs/accounts.md.

## `frontend/src/app/explore/EmotesSection.tsx`

`export function cleanEmoteName`: What a name box holds, as typed: lowercase, spaces and dashes as `_`, nothing else the rule refuses, 32 at most.

`export function EmotesSection`: The manage dialog's `emotes` tab (docs/chat.md "emotes"): the group's custom emotes, for an
owner or a role with the emotes power. `add emote` picks a file, and the crop dialog takes it
from there: a square over the picture (dragged, its corners pulled, the slider and the wheel to
zoom), the name under it, and `save` sends both, the dialog staying up to say a refusal. The
list is each emote's picture, `:name:`, who put it up, and a rename and a delete; the count
against the cap over it. A change reads the login's own emotes again (`loadMyEmotes`), so the
composer's list and the picker have it at once.

## `frontend/src/app/explore/ExplorePage.tsx`

`export function ExplorePage`: The groups you are in, then the public ones you are not. `bot` is a badge, not one of these.
`create` is for a login under the cap on owned groups (the api's `groups_per_owner`), so
one at the cap is not offered another.

## `frontend/src/app/explore/PinSheet.tsx`

`export function PinSheetButton`: A phone's pin in a group's title row (between the back caret and the drawer's opener): a
44px square, the count on its glyph's corner in the bell's blue square while there are any.
It opens and shuts the sheet (`PinSheet`); lit while that is down.

`export function PinSheet`: A group channel's pins on a phone (docs/groups.md "pins"): a sheet from the top, straight
under the title row, 60% of the window tall, the row over it whole and still pressed. The
pinned lines, newest pin first, drawn as the chat draws them (`RoomLines`: the shape this
browser picked, the faces, the badges, the pictures), with a jump to the line in the channel
on each and, for the channels power, an unpin: 44px each, in a column of their own at the
line's right, so they never sit on its words. The first line clears the sheet's top edge. It
scrolls in itself; the grabber at its foot. A swipe up shuts it, on the grabber, or on the
lines once they are scrolled to their end (or fit); so do the pin again, a tap on the dim
page under it, Escape and the back button. The slide is 200ms, none for reduced motion. Drawn into the body under the title row (z-20, the
row is z-30) and clipped to the window below it, so it slides out from under the row; a
drawer (SwipeDrawer.tsx, z-50) and its dim go over it. The list is asked as it opens and
again on each pin or unpin while it is (`pinsTickAtom`).

## `frontend/src/app/explore/VoiceFailDialog.tsx`

`export function voiceFailWords`: A join's reason (voice-atoms.ts `fail`) in words a person can act on, by what is in it.

`export function VoiceFailDialog`: Why a voice join failed, once its last try did. ConfirmDialog's way: mounted = shown, a native
<dialog> opened modal on mount, on the page's body; a phone's is a sheet up from the foot
(MobileSheet.tsx). The human reason first, the raw one under it, then close and retry.

## `frontend/src/app/explore/VoicePanel.tsx`

`export function VoicePanel`: The group's voice channels and who is in each (docs/voice.md), over the roster. A click on a
channel joins it; while in one, the header has mute, deafen and leave at the right, and its row
has the signal (how the call is getting through, the numbers on hover) at the very right. Who is in
where is the room's `voice`, kept by the `voice` and `voice_left` facts; a ring on a face is
that person speaking, for the channel you are in. Always there: every group has a voice
channel (made with it, migration 0005 for the older ones). `onAdd`, given to the channels
power, puts an `add channel` row after the last channel; ServerRoom has the dialog. With
`addFull` (the server has its 4 voice channels, VOICE_CHANNEL_CAP) the row stays, greyed,
and says the cap on hover and focus. With
`onEdit`, a channel this login may change (`can_edit`: who made it, or the channels power)
has a pencil at the right of its row, up with the pointer on the row, that opens its edit
(the name and the line about it; ServerRoom's dialog again). The call is the page's, not this panel's: a phone's drawer shutting keeps it, and leaving the
page (ServerRoom's room effect) ends it.

## `frontend/src/app/explore/VoiceRoom.tsx`

`export function useVoiceView`: The voice channel on screen in place of the chat, from the page's `?voice=<channel>`: a click
on a voice channel puts it there, a click on a text channel (a link without it) takes it off,
and the back button does what it should. Null for none, or a name that is no voice channel of
the room. `open` puts one there and keeps the page's path.

`export function VoiceRoom`: A voice channel as a call, where the chat is (ServerRoom). Not in it: a card with the
channel, who is in it, and `join voice`. In it (joining or joined): everyone as a tile, their
camera or their face, a ring while they talk, their mute and deafen; a screen shared is a tile
of its own. A click on a tile puts it big with the rest in a strip under it, a click on it
again puts it back. Under them the call's bar: mic, deafen, camera, screen, the voice tab,
leave. The call is voice-atoms.ts's and voice-video.ts's; this only draws it.

## `frontend/src/app/home/hover.ts`

When a card plays its camera: after the pointer has rested on it, until a little after the
pointer has left. The timers and the hover setter come in as arguments, so there is no React
or DOM in here and the same code runs under plain node.

`export const HOVER_DWELL_MS`: A pause, not a pass across the grid. Under this, hovering a card sends nothing.

`export const HOVER_GRACE_MS`: Crossing from the picture to the name must not hang the preview up.

`export interface HoverTimers`: `window`, or a fake clock.

`export type SetHover`: A `useState` setter: the next value, or a function of the current one.

## `frontend/src/app/home/stills.ts`

The one picture a home card shows for the whole visit: one of the streamer's own when they
put some, else one camera frame, asked for again a few times while that frame is not written
yet. The url builders come in as arguments, so there is no api client or React in here and
the same code runs under plain node.

`export const STILL_TRIES`: How many times to ask again for a camera frame that is not written yet (~6s after go-live).

`export interface StillUrls`: `api.streamThumbUrl` and `api.thumbUrl`.

`export function stillPictures`: One per page load, so a refresh can land on a different picture and a sitting page never does.

## `frontend/src/build.d.ts`

The commit the pages were built from. Filled in by vite `define` (see vite.config.mts); "dev" on the dev server.

## `frontend/src/utils/count.ts`

`export function compactCount`: A count short enough for a phone's title row: `34`, `1.2k`, `3m`.

`export function streamNumbers`: A stream's numbers under its name on a phone: `1.2k followers · 34 watching`, either part left out while it is not known.

## `frontend/src/utils/since.ts`

`export function since`: How long a stream has been live, in words: "just started", "live for 12 min", "live for 3 hr",
"live for 2 days". Whole units, rounded down: "1 hr" means at least an hour, not 31 minutes.
`now` is the caller's clock in ms (a render must not read one). Skew clamps to zero.

`export function ago`: How long ago something was, in words: "just now", "12 min ago", "3 hr ago", "2 days ago".
The units and the rounding of `since`, and the same `now`. The recently offline cards on
home say when the last stream ended with it.

`export function monthOf`: The month something happened, in the viewer's time zone: "october 2026". No clock: a month
does not age the way `ago` does. The socials tab says when an account was made with it.

## `frontend/src/utils/tabs.ts`

`export function roveTabs`: The keys of a `role="tablist"` whose tabs are buttons that open on a click: arrows move the
focus along the tabs and open the one landed on, Home and End go to the ends. The tablist's
`onKeyDown`. The watch page's tabs and the profile popup's; the user modal's do the same
from its own list of tabs.

## `frontend/src/app/explore/ServerRoom.tsx`

`export function ServerPage`: A group as a server: `/groups/<server>` and `/groups/<server>/<channel>`, one page, keyed
on the server by the router so a change of channel is a change of what is shown and nothing
more. The room (the group, its channels, who is live, the roster and the bans this login may
see) is asked once when the page arrives, with the last lines of every channel, and then the
events socket keeps it: every change arrives as a `group` frame and lands in place
(room-atoms). The chat is one socket for the whole server; the channel list swaps what the
panel shows. The banner and the picture sit over the channel list and a chat that reads as
a room, not as the stream's panel. Whoever is live is a tile under the channels, on the
left (`LiveFace`, at most FACES playing); with every camera off the column is the channels alone.

The page is two views, and snaps between them: the room, the height of the window under the
title row (ROOM_HEIGHT), which is where the page lands when it opens, and the top, the
banner, the picture, the name and the line about it, a scroll up away. The window is the
page's scroller, so the snap type goes on <html> while the page is up; each view is a
`snap-start` area (TOP_VIEW, `#group-room`; stacked, each block of the room). The landing is done once, on the first thing
with the room's shape (the skeleton, or the room itself), so the room arrives in place.
