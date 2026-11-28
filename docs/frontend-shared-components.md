# frontend/src/shared-components

the header comment of each file in `frontend/src/shared-components` and the doc comment of each export, moved here when the source lost its comments (`.cursor/rules/no-comments.mdc`). the code is the truth; these say what a file was written for at the time of the move, so check a detail against the code before trusting it.

## `frontend/src/shared-components/About.tsx`

`export function About`: Keyed on the name by the caller: another name is another page, read fresh.

## `frontend/src/shared-components/AuthDialog.tsx`

`export function AuthDialog`: Log in or sign up over the page you are on, instead of a page of its own: the sidebar's two
words, "log in to create" on the groups page, "log in to join" in a group, and the /login and
/signup links (AuthPage.tsx lands you on their `next` with this open). Mounted by the Shell;
it renders nothing until `openAuthDialog`. A logged in form closes it and you stay where you
were. The ConfirmDialog and UserModal recipe: a native <dialog>, so the browser keeps focus
in it, closes it on escape and hands focus back to what opened it; a click on the backdrop
closes it too.

## `frontend/src/shared-components/AuthForm.tsx`

`export function AuthForm`: Log in and sign up, one form: a name, a password, a button. The password goes to the api as
typed, over https; the api hashes it. See docs/accounts.md. The autocomplete values are what
make password managers offer to save it. Shown in the auth dialog (AuthDialog.tsx), over
whatever page you were on; the security tab has its own.

## `frontend/src/shared-components/Avatar.tsx`

`export function Avatar`: A streamer's picture. The api serves the same <img> inside the watch page's
pre-react card (api/src/profile.rs, `AVATAR_IMG_CLASS`), so the two class
strings are kept the same there and here.

## `frontend/src/shared-components/AvatarLayer.tsx`

`export interface AvatarVoice`: Whose picture an avatar layer shows, and the sound that moves it.

`export function AvatarLayer`: The streamer's avatar as a layer of the frame (docs/screen.md): their profile picture, or
the letter their name makes, a square centred in the box, moving with the voice the way a
png avatar does. Both sides draw it from the name alone; what moves it is the sound each
side has (the mic here, the opus arriving there), so nothing about it travels but its box,
no picture is encoded, and it moves while the streamer is in another tab. Many readings a
second, so the motion is written straight onto the element from a frame loop (`mic-level.ts`
reads, this moves) and never through react: `transform` for the nod, `data-speaking` for the
ring, `data-voice` 0..100 for the tests. Someone who asked for less motion gets the ring alone.

## `frontend/src/shared-components/Badge.tsx`

`export function Badge`: A group's badge, the way discord tags a bot: the group's picture, tiny and square, then a
small solid box in the group's colour with the word in capitals, next to a name. One unit,
the height of the word's line (16px), so nothing it sits in grows. The picture's version is
the freshest the page has heard (`groupIconsAtom`), else the one the line carried, and the
colour likewise (`groupColorsAtom`); no
picture is its first letter on its colour, as `GroupMark` draws everywhere. The word is
white or black by the colour's own lightness, not the theme's, so it reads on any theme and
with any colour a group picked. With `card` it is a tab stop, and hovering or focusing it
shows the group's card instead of the browser's title.

## `frontend/src/shared-components/Button.tsx`

`export function buttonClassName`: Shared classes so a router Link can look like a button: a border and a fill, and a hover that
changes a colour. No shadow and no press movement (no-box-shadow.mdc). Disabled: dim, and
hovering changes nothing.

## `frontend/src/shared-components/Calendar.tsx`

`export function Calendar`: When they stream (docs/calendar.md): a week of day columns, monday first, and the hours of
the day down the side, midnight at the top. A stream is a bar in its day's column from its
start hour to its end hour, with how long it ran written on it. Days across and hours down
on purpose: every 8pm is the same height, so a person who streams at 8 is a row of bars you
see before you read anything. The line above the grid says it in words. Everything is the
viewer's clock and zone: a block over the viewer's midnight is two pieces in two columns,
the longer of them carrying the length. A connection that dropped and was back inside five
minutes is nothing to see: the two sessions are one bar, the gap inside it and counted. Bars
are the accent; one the sweeper closed is grey with a dashed end (its end is the last
heartbeat). The open bar ends at a line that moves, once a minute. The watch page's tab, and
the profile popup's (ProfilePopup.tsx), which may stand over that page: the popup's grid has
rows of its own (`scope`), ids of its own (`id`), and its own word for whether they are live.

## `frontend/src/shared-components/ChatAttach.tsx`

`export const ATTACH_ACCEPT`: What the box's file picker (`accept`), a paste and a drop take: pictures, and the two videos
the chat plays. Anything the browser calls a video may be picked, so a `.mov` hears why not.

`export const STREAM_CHAT_VIDEO`: Videos in a stream's chat (docs/chat.md "videos"): off until a stream's chat has moderation, so
its box takes pictures alone (`PICTURE_ACCEPT`) and a video dropped or pasted there hears
`STREAM_VIDEO_OFF`. A group channel and a direct message keep them. `true` turns them back on;
the chat holds the same flag and has the last word (chat.rs `STREAM_CHAT_VIDEO`).

`export function filesOf`: The files a paste or a drop carries, pictures and videos alike; none for words alone.

`export function splitFiles`: Pictures and videos apart: each goes up its own way.

`export function dragFiles`: A box's drop and paste (`dragFiles`, `dropFiles`, `pasteFiles`): files dropped on it or pasted
into it go where the picker's would (`take`). A paste of words alone is the browser's as ever;
a drag of words is left alone too. Here, a drag of files over the box may drop there.

`export function useVideoUpload`: One video going up (docs/chat.md "videos"): checked here first (`readVideo`: the type, 10 mb,
30 seconds), then the file itself (the api draws its poster) with its progress, 0 to 1 (`progress`, null when nothing is going up). `done` gets the video;
a refusal is `fail`'s, in the words the box shows.

`export function VideoProgress`: The bar over the box while a video goes up: how much of it has gone. `idPrefix` keeps a direct message window's ids apart from a room's.

`export function PendingVideo`: The video waiting to go with the next line, among the pictures' strip: its poster with a play mark, and its ×.

## `frontend/src/shared-components/ChatEmbeds.tsx`

`export interface Embed`: A video link in a line, as its card draws it.

`export const MAX_EMBEDS`: At most this many cards under one line: the first video links in it.

`export function startOf`: YouTube's `t=` (or `start=`): `90`, `90s`, `1h2m3s`. 0 for none or one it cannot read.

`export function embedOf`: The card a link makes, or null for a link that is not a video this knows. The same hosts as
`has:video` (`VIDEO_LINK` in api/src/history.rs), less Kick, whose clips have no player to
frame, and `.m3u8`, which only Safari plays. Twitch's player wants the page's own host as
`parent`, or it will not draw.

`export function embedsOf`: The video links of a line's words, in order, each once, at most `MAX_EMBEDS`. The links as `LinkedText` draws them.

`export function ChatEmbeds`: The players for the video links of a line (`embedsOf`), under its words and its pictures, like
discord. Nothing of the provider's loads until a click: a poster card first (YouTube's own
thumbnail; the others the provider's colour, its mark and the address), then on the click the
provider's player in a frame. A link to a file is a plain `<video>` that fetches nothing until
it is played. The frame is sandboxed without `allow-popups`, so a link inside a player cannot
open a tab past the leave-site word; the card's own `open on …` link goes through it
(`ExternalLink`). Off with the chat tab's `show embeds` (`settings.showEmbeds`).

## `frontend/src/shared-components/ChatLine.tsx`

`export function stamp`: The clock of a line in full, in the browser's own words: its title.

`export function clock`: The clock of a line, short, where a shape shows it: `HH:MM`, the hours of the day the way a
log keeps them, so every time is five characters and the column at the left of the lines
stays one width. A line with no time on it shows none; the full stamp is the line's title.

`export function when`: The clock of a search hit, short: the time for a line said today, the day for an older one
(`8 Nov`, and the year with it when it is not this one), since hits reach back through the
whole room where the lines on screen are a stretch of one evening. The full stamp is the title.

`export interface Place`: Where a line stands in its run and its minute, from the line before it on screen (`placeOf`).

`export function placeOf`: A line's place after the line before it on screen: `prevAt` its time (none for the first on screen), `same` whether the two are one person's.

`export const BAR_BUTTON`: The action bar's buttons: an icon a little box, a thumb wide on a phone.

`export interface LineMenuItem`: A row of the action bar's `more` menu.

`export function LineActions`: A line's action bar, discord's: react, reply, the caller's own buttons (`extra`: a group line's
pin), and `more` with the rest (reply again, `copy text`, the caller's `menu`). Up at the line's
top right on hover or focus, or after a long press on a phone (`ChatLineShape`'s `actions`).
`onReact`: the smiley opens the reaction picker (Reactions.tsx) over the line's `reactions`, `me`'s
lit. Absent, `reactOff` says why (a nick: `log in to react`) on a dimmed smiley, and with neither
there is no smiley (a pinned copy of a line). `onReply` absent: no reply (a pinned copy of a line,
which is not where a conversation goes on).

`export interface Quoted`: What a reply answers, as the line carries it (chat.rs `Reply`, dms.rs `quote_json`). `gone`: the line is not there any more.

`export function quoteWords`: A quote's words: the start of the line on one line (an emote as its `:name:`), or its pictures (or its video) when it had no words.

`export function ReplyQuote`: The line a reply answers, over the reply (discord's): in `log` and `blocks` a thin spine curling
from the face's column (the time's in a log) up into the quote, then the speaker's tiny face,
their name in bold and one line of their words, cut to fit; in `bubbles` the same quote at the
top of the box, a stroke at its left. A click goes to the line (`onJump`), which lights up there
or says it is not to be found; a line that is gone says so and goes nowhere. `color`: the name's,
their role's in a group's channel (ChatPanel.tsx `useRoleColors`); the text's otherwise.

`export function ChatLineShape`: One line of any chat, in the shape this browser picked (settings.chatStyle; the chat tab's
cards): a stream's and a group channel's (ChatPanel.tsx) and a chat with a friend's
(FriendChat.tsx) are drawn by this alone, so the three shapes are the same three everywhere.
The time stands at the left in every shape, one column. `log`: the time, the name, the
words, one line; the words wrap under the name, not under the time. `bubbles`: the words in
a box of their own, yours on the right in the blue stroke and theirs on the left in the
grey one, the lines of one minute together with the time at the left once; a room's box
that is not yours wears the name on the first of a run (`crowd`), a thread's sides say who,
and the name is there for a reader whenever it is not drawn. `blocks`: the first line of a
run wears the writer's face, their name and the time over the words, and the lines after it
in the run stand under, the time at the left as the minute turns. The same `<p>` whatever
the shape, the caller's `attrs` on it and the full stamp as its title. The pictures stand
under the words in every shape (inside the box in `bubbles`). The text size is the list's:
`text-sm` in both, the panel and the window. A reply's quote (`quote`) stands over the line;
the action bar (`actions`) floats at its top right; a `side` column, if any, stands in the
line's row at its right, beside the words, never over them.

## `frontend/src/shared-components/ChatMod.tsx`

`export const LINE_TIMEOUT_SECS`: The timeout a line's button hands out. Longer, or shorter, from the mod tab's lists is not a thing yet: lift it and give another.

`export function ChatModActions`: A janny's buttons on a stream chat's line (docs/jannies.md): delete, and for a login's line time
out (10 minutes) and ban, each after a yes. Not on the streamer's lines, nor on my own: the api
refuses anyone of my rank or above anyway, and says so under the box. A nick has no account to
ban, so their lines get the delete alone.

## `frontend/src/shared-components/ChatSearch.tsx`

`export type FilterKey`: A filter's key, as it stands before the colon in the query (`channel` is also read as `in`).

`export interface Filter`: A filter button under a search box: the key, its glyph, and what it does, as its tooltip.

`export interface SearchPerson`: Somebody `from:` can offer: the name, and their picture's version (null for the letter their name makes).

`export interface Chip`: A filter taken out of the words into a chip in the box: `from:bob` as bob's face and name.

`export interface Suggestion`: What the word under the caret could be completed to: a filter and one of its values.

`export const SEARCH_MAX_CHARS`: The box, in characters: the api's (history.rs `SEARCH_CHARS`), which refuses a longer one.

`export function useChatSearch`: The words of a search, and the filters on them, for a box the caller draws (`SearchField`):
the group room's over the roster (for a member and a guest alike), the direct message
window's under its header. `input` is that box, for the focus a filter hands back to it and
the caret a pick puts in it. Submitting asks the room on screen (`searchRoom`), or whatever
`ask` says (the window asks its thread, `searchDm`); the hits are the caller's
`SearchResults` pane, laid over its lines (the chat panel's, for a group).

The filters are chips in the box, not words (Discord's way): `from:` as the person's face and
name, `has:` as its kind's glyph, the days as a calendar and the day. A filter word typed out
becomes a chip once a space follows it, or when one of its values is picked from what the box
offers under the word: `options.people` for `from:`, each with their face, the three kinds for
`has:`, a group's channels for `channel:` (`options.channels`, which also puts `channel` among
the filters), a day picker for `before:` and `after:`. The query sent is the same words as
ever, the chips first (`from:bob has:image hello`).

`export function SearchField`: The search box: one bordered box with the chips in a row and the input after them, wrapping
when they are many, and under it what the word under the caret could become: the list
(`SearchSuggestions`) or the day picker (`SearchDay`). A press on the box's empty part puts
the focus in the input. While the day picker is up, the down arrow or tab in the box goes into
it, and enter takes a whole day typed after the colon (`before:2026-10-30`), or goes into it.

`export function SearchFilters`: The filter buttons under the box: each its glyph and its key, a click starts the filter in the
box (its list, or the day picker, comes up), its tooltip what it does. Blue while it has a chip
in the box. The press leaves the focus where it is, so a box that shows these only while it has
the focus (the group room's) keeps them through the click.

`export function SearchSuggestions`: What the word under the caret could become, under the box: a list in a box of its own (a
stroke, no shadow), one row a suggestion, the one the arrow keys rest on in blue. A `from:`
row wears the person's face before the name, a `has:` row its kind's glyph, a channel's `#`.
A press on a row leaves the focus in the box; the click makes the chip. Nothing while there is
nothing to offer.

`export function SearchResults`: The hits of a search where the lines were, the whole of their place: a row at the top with
what they are for, how many, and `close`; then the hits, a row each (`SearchHit`), or
`nothing`. The caller lays it over its lines (`absolute inset-0` in the lines' box), which
keep their place under it as `invisible`, so their scroll, their refs and their listeners
hold, and a line coming meanwhile still lands at the bottom; `close`, or a hit picked, takes
the pane away and the lines are as they were. The room chat's (ChatPanel.tsx, `#chat-results`)
and the direct message window's (FriendChat.tsx, `#friend-chat-results`) are this one.

`export function SearchHit`: One hit in the pane: the clock at the left, then the name and the words, wrapped in full, and
the picture mark with a count for pictures. The whole row is the click (the button's `after`
covers the row, the clock with it), and a pointer or the focus on it tints the row.

## `frontend/src/shared-components/ChatSlot.tsx`

`export function useChatWindowBar`: The window's bar, for the chat's header (ChatPanel.tsx) to be it. `null` beside the video, as a tab, and anywhere outside a ChatSlot.

`export function useChatSide`: Where the stream's chat is: the layout setting, except that a phone (mobile.ts) has no window
floating over the page. There the "window" is the column under the video, as left and right
are: still the one dialog (`#chat-modal`), never shown over anything.

`export function chatLayoutClass`: The page grid for a chat column. The column width and the gap ease shut when the chat is
closed, so the video takes the row; the dialog inside keeps its own height until that slide
is done, or the panel would squash instead of leaving to the side. A window is no grid: the
dialog floats.

`export function ChatSlot`: The stream's chat, in whichever place the layout setting says. One `<dialog>` for the life
of the page, so a change of the setting never remounts the panel inside (a remount is a
reconnect). Left or right, the dialog is just the column: it is not open, and it is drawn
in the page, sliding out to that side when the chat button closes it. In a window, `show`
(not `showModal`) puts that same dialog over the page without freezing it: drag the chat's
header (its one bar, with the close at its right), pull a corner. Closing fades it and leaves the room connected; the chat button on
the video opens it again.

`tabbed`: the column is a tab under the video instead (the watch page's body is too narrow to
stand it beside, WatchPage.tsx). There is no chat button then, so it is open whatever the
button last said; the page hides it while another tab is up. Its height runs from where it starts
to the window's foot (`--chat-top`, measured here), so the send row is on screen without
scrolling the page; the page keeps the video short enough to leave it room.

`export function ChatOpenButton`: On the video: opens the chat, or closes it. A column slides out to its side; a window fades.

## `frontend/src/shared-components/ConfirmDialog.tsx`

`export function ConfirmDialog`: A yes or no before something that cannot be undone (stopping a stream from its corner
player). Mounted = asked, the way UserModal is mounted = shown: a native <dialog> opened
modal on mount, so the browser keeps focus in it, closes it on escape and hands focus back
to the button that asked. Every way out goes through the element's `close`, which says
which answer it was. It is asked in its own window, the page's or the popped-out player's,
and not inside another dialog: a modal inside a modal closes the outer one with it. "no"
has focus to begin with: a stray enter changes nothing.

## `frontend/src/shared-components/CornerPlayer.tsx`

`export const CORNER_BADGE`: Where the `badge` goes: the top left corner, level with the chat button and × (5% of the way down, 8px at least).

`export const CORNER_BADGE_2`: A second chip in the `badge`, beside the first: one chip's width and the gap further in.

`export interface CornerChat`: The chat the player's chat button opens.

`export function CornerPlayer`: A stream in a floating box: the picture with the chat button, pop out and × on it, the name
and the status word under it, and the stream's chat where the picture in picture setting
puts it. Drag it by the picture or the footer, pull a corner to resize it (16:9, the far
corner stays put); it never leaves the screen, and it stays where it was put for the rest
of the visit. Clicking it goes to the stream's page; dropping it does not. Until the first
drag it sits in the stack at the bottom right corner (MiniPlayer). Pop out (where the
browser has document picture in picture) takes the same box, chat and all, out of the page
into an always-on-top window of its own, over other apps too; the window is the box then
(the os moves and resizes it, the picture fits whatever shape it is given), the button in
it brings the box back where it was, a click on its picture or its name brings the tab to
the front on the stream's page, and the window goes with the box: back on the stream's own
page, or ended. With `popOutOnLeave` the player goes out by itself when the tab is left,
and comes back when the tab does. What the box shows is the caller's: the watch player and
the broadcast's player are the two.

## `frontend/src/shared-components/CropDialog.tsx`

`export function CropDialog`: The crop dialog (infra/picture.ts): every picture the pages put up passes through it. Mounted
by the Shell; it renders nothing until `cropPicture` asks, and remounts per request. A native
<dialog> opened modal on mount, the way ConfirmDialog is: the browser keeps focus in it, closes
it on escape and hands focus back to the button that picked the file. Over the user modal it
sits on top, in the top layer.

## `frontend/src/shared-components/Emote.tsx`

`export function Emote`: One emote token drawn (docs/chat.md "emotes"): its picture, with `:name:` and its group in the
tooltip and `:name:` for a reader (and a copy). `info` is what the api said the id is: undefined
while it is being asked (the picture is drawn already, under the token's name), null for one
that is gone, which is the plain `:name:` it was written as. A picture that will not load is
that too.

## `frontend/src/shared-components/EmoteComplete.tsx`

`export interface EmoteCompleteBox`: What a composer's box spreads on itself for the list: its keys, its caret, and the combobox words for a reader.

`export function useEmoteComplete`: The composer's emote list (docs/chat.md "emotes"): `:` and two or more letters of a name just
before the caret open a drop-up over the box with the login's emotes that match (the picture,
`:name:` and the group), the names that start with the letters first. The arrows walk it, enter
or tab puts the one lit in, escape shuts it until the letters change, and a click picks too.
The pick goes in as `:name:`, which the send writes as the emote's token (emotes.ts
`encodeEmotes`), and the box keeps the caret after it.

Every composer has it: a stream's chat and a group's channel (ChatPanel.tsx), a direct message
(FriendChat.tsx). `box` is spread on the `<input>`, whose own key handler calls `onKeyDown`
first and stops when it says it took the key; `list` goes in the box's row, which is `relative`.

## `frontend/src/shared-components/ExternalLink.tsx`

`export const EXTERNAL_REL`: What every link out of this origin wears: a new tab that gets nothing of this page (about.md's rule for a link).

`export function siteOf`: The site a link goes to, for the words: its host, without a `www.`.

`export function useExternalLink`: The one way a link leaves this site (.cursor/rules/external-links.mdc): while the links
setting asks for it (the chat tab, `settings.linkWarning`), a click on it, a cmd/ctrl/shift
click or a middle click included, shows the word first (`LeaveDialog`) in place of the tab. A
link on this origin is let through as it is. `from` is who put the link there, the word's
first sentence. Spread the handlers on the `<a>` and draw `dialog` beside it; or take
`ExternalLink`, which does both.

`export function ExternalLink`: An `<a>` to another site: a new tab with `EXTERNAL_REL`, through the word while the links setting asks.

`export function LeaveDialog`: The word before a link out: which site it goes to, the whole address, and the way on or back.
On the page's body, not inside whatever drew the link (a modal inside a modal closes the outer
one with it), and in the link's own window: the popped-out player's when the chat is there.
The way on is the link itself, so the browser opens the tab the way it opens any link;
`don't ask again` turns the links setting off as it goes through, and the chat tab turns it
back on.

## `frontend/src/shared-components/Face.tsx`

`export function Face`: Somebody's picture, or the letter their name makes when they have none. One shape wherever a face goes.

## `frontend/src/shared-components/FollowButton.tsx`

`export function FollowButton`: `follow` with the add glyph in the blue fill, or, for a name the login follows, `following`
with the check glyph in the green fill, which turns to `unfollow` with the cross glyph, in red,
while pointed at, so the word says what the click does. The same box in every state: a
follow does not turn the button into bare words. A guest's follow is this browser's own
(follow-atoms.ts): kept here and told to nobody, so it is not one of the name's followers
and `onChange` is not told. See docs/follows.md.

## `frontend/src/shared-components/FriendChat.tsx`

`export function FriendChat`: Direct chats with friends (docs/dms.md), opened from the sidebar: one window, a tab per
friend down its side, dragged by its header, resized from a corner. The lines are the
api's: a page on opening a thread, older pages as you scroll up, new ones as they come on
the events socket, from either side and from your other devices. A thread keeps its
half-typed draft, and the pictures picked for its next line, while another tab is shown. The
header is the name alone, the glass and the ×: the glass opens a search box under it
(`#friend-chat-search`, the room chat's words and filter chips, `ChatSearch.tsx`) that asks
the thread on screen (`searchDm`); the hits take the lines' whole place (`#friend-chat-results`,
`SearchResults`, the lines kept under it unseen), and one clicked puts the lines back with
it in view, the pages back to it loaded as needed (`openDmLine`); `close` puts them back as
they were. The ×
hides the window and keeps everything; a friend's chat button in the sidebar brings it back. With no tab
shown, the friends to pick from are where the thread would be, under `no chat` when there
are no tabs at all (a phone's sheet: under `friends`, as a list, and its back button and the
browser's back come to it from a chat). The lines take the shape the chat tab picked for every chat
(settings.chatStyle, drawn by ChatLine.tsx as the rooms' are): a log, bubbles, or blocks;
the log carries it as `data-style`, and your name is the blue one. A line may carry
pictures, the room chat's way: the picture button beside the box (`#friend-chat-picture`)
picks files, each is shrunk and put up at once and waits in a strip over the box with its ×
until the line goes; a line may be pictures alone.

## `frontend/src/shared-components/Friends.tsx`

`export const RAIL_FACE`: A face in the column: 2rem (`FACE_REM`), 2.5rem on a phone (`MOBILE_FACE_REM`).

`export function RailFace`: The picture and the presence square in its bottom right corner, the way the closed panel
shows everyone (PresenceSquare.tsx): grey, green, the accent streaming. Closed, the
column has no words; the word is in the row's label, and the square says it on hover.

`export function Friends`: The body of the sidebar (docs/follows.md), in both of its states: the search box, then the
lists, each under its icon with a line between one and the next: friends, the rest of who you
follow, the groups you are in, in the order settings put them and only the ones it switched
on (settings.sidebarLists). Closed, each is a square in one column (the box is its icon, the
icons stand alone); open, the same squares stay where they are and the words and buttons
come out beside them, so what you were pointing at is still under the pointer. The whole
column is one stack with one gap between everything, sized (`measure`) so that the lists,
cut at whole rows, spend the room exactly; the lines between them, which drag, say how the
rows are shared, and the caret before each icon folds its list to the icon line, this
browser's choice (settings.sidebarFolds). The site's one search: letters in the box put what they find where the
lists were, the groups first (yours, then the public ones; a group is matched here, from the
explorer's answer), then the people (the api's answer to the letters as they stand, asked a
beat after the last one and kept a short while, `setSearchQuery`), each row with the buttons
its list would give it, a follow button for a name you do not follow; closing the panel
empties it. Every open asks `GET /api/following` again, and `GET /api/explore` for the
groups while they are shown, so the words are now; the first letter asks the explorer too
unless that open just did (nobody's too: the public groups are theirs to find). A guest has
the following list alone: the names this browser keeps (follow-atoms.ts), each with what its
profile read says, asked on every open as a login's list is; nobody in it is a friend, and
the groups are a login's.

## `frontend/src/shared-components/GeneratedAvatar.tsx`

`export function colorOf`: The colour a name gets. The hue comes from the hash; lightness and chroma are fixed (oklch,
so a yellow is as bright as a blue), which keeps every one readable under white text on the
dark theme.

`export function GeneratedAvatar`: A stand-in picture made from the name alone, the way discord fills in a default avatar: a
64x64 pixel-art face drawn on a `<canvas>` (`image-rendering: pixelated`), the same every time
for the same name and different for a different one. The name, trimmed and lowercased, is
hashed (FNV-1a, the same `hash` as `colorOf`), and four 4-bit slices of the hash pick the skin,
hair, clothes and background from 16 colours each: 65,536 combinations. Case does not count
(the chat treats `Billy` and `billy` as one name), so neither does it here. An empty name is a
`?` tile.

`paletteFor` (not exported) maps each region char of the map to its colour for this name: `0`
`OUTLINE`, `1` `SKIN[h & 0xf]`, `2` `HAIR[(h >> 4) & 0xf]`, `3` `WHITE`, `4` `BOW`, `5`
`CLOTHES[(h >> 8) & 0xf]`, `6` `BG[(h >> 12) & 0xf]`.

## `frontend/src/shared-components/avatar-data.ts`

Generated, not written by hand: the avatar data for the default avatars (version 6). Regenerate
it rather than editing it. No generator script is in the repo.

- `AVATAR_SIZE`: 64.
- `REGION_MAP`: the 64x64 region map, one string of 4096 chars, row by row from the top left.
  each char names a region: `0` outline, `1` skin, `2` hair, `3` highlight, `4` bow, `5`
  clothes, `6` background.
- `SKIN`, `HAIR`, `CLOTHES`, `BG`: 16 hex colours each, the slots the name's hash picks from.
- `OUTLINE`, `WHITE` (the highlight), `BOW`: the fixed colours.

## `frontend/src/shared-components/GroupColorPick.tsx`

`export const GROUP_SWATCHES`: The colours a group picks from, by name (the tooltip says the colour, not its hex): discord's blurple, then the fake streams' box colours. The colour box takes any other.

`export function GroupColorPick`: A group's colour: the swatches, then a square of the colour that is the browser's own picker
for any other. 24px squares, laid into the caller's flex row; the create dialog's and the
manage dialog's `color` section. `id` is the picker's.

## `frontend/src/shared-components/GroupMark.tsx`

`export function GroupMark`: The group's picture, or the first letter of its name on its colour. `name` is the address
(`gaming-0042`), which the picture's url is built from; its first letter is the title's.
`src` is a picture not up yet (the create dialog's preview, an object url), shown instead.

## `frontend/src/shared-components/GroupMod.tsx`

`export interface ModAsk`: A moderation asked for, waiting on its yes. `line` for a delete.

`export const modAskAtom`: The question up, null for none.

`export const memberInfoAtom`: Whose info is up, null for none.

`export const TIMEOUT_PICKS`: How long a timeout runs, the picks (seconds): the api takes ten seconds to a week.

`export interface ModPowers`: What this login may do to one member here.

`export function modPowers`: What this login may do to `name` in `room`: nothing to themselves, nothing to an owner (the api
lets an owner act on another; the page leaves it to the members tab), and the powers they hold
(an owner and a site admin hold all of them, `perms` says so). A member the roster has not
loaded yet counts as no owner: the api refuses if they are one.

`export function voiceSeatOf`: Where `name` sits in voice here, and whether a moderator muted them; null when they are not in voice.

`export function useCardMod`: The buttons on `name`'s card (PersonCard.tsx `actions`), for the room on the page: mute or unmute
and disconnect while they are in voice, then kick, time out and ban (red), then their info.
Null when this login may do none of it. `close` takes the card away as a button opens its question.

`export function lineModItems`: A channel line's moderation, for its `more` menu: `delete message` on your own line, or anyone's
with the kick power (an owner's never, the page's rule); then, past a divider, kick, timeout
and ban on its author, red. None for a line nobody here may touch.

`export function GroupModHost`: The one question and the one member's info the page has up, for the room on it.

## `frontend/src/shared-components/GroupSquare.tsx`

`export const GROUP_SQUARE_BOX`: The square's box: its size, stroke and fill. A stand-in square takes the same, so the two cannot drift.

`export function GroupSquareFace`: What a square shows, inside a box that is `relative overflow-hidden` and a `group`: the banner
or its colour, the picture, the name and the members. `corner` goes at the top right. `compact`:
a smaller picture and padding on a phone, for a grid of two across a narrow pane.

`export function GroupSquare`: One group as a square: the banner or its colour, the picture, the name.

## `frontend/src/shared-components/Inspector.tsx`

`export function Inspector`: The messages inspector (docs/status.md): the frames this browser sent and got on its three
sockets, the last 1000, newest at the bottom, with a filter and the direction toggles. A
`<dialog>` opened with `show()`, not `showModal()`: the frames worth watching are made by
using the page, and a modal would freeze it. Floats over every page (mounted by the Shell),
dragged by its header, resized from its corner. Renders nothing until `openInspector`.

## `frontend/src/shared-components/KbdDebug.tsx`

`export function KbdDebug`: Temporary: what a phone page that is the window (WatchPage.tsx, LivePage.tsx) sees while its chat is
typed in, read every frame, so the strip (mobile.ts, `keyboardStrip`) can be checked on a real iOS
Safari. A small box over the page: the focus, the visual viewport, `innerHeight`, and the height
the player's box (`data-kbd-video`) has right now.

## `frontend/src/shared-components/LinkedText.tsx`

`export const TALK_FROM`: Who put a link in a line, for the word before it.

`export function hrefOf`: Where the link goes, or null for one the browser would not take as http(s). A `www.` link is
https. Null too for a match the trim left without its `https://` or `www.` (`www..` → `www`):
`linkHref` would take that as a path on this site. And null for this origin with a path that
starts `//` (`https://<site>//evil.example/`; `\\`, `/\` and `/..//` parse to the same).

`export function splitLinks`: The words apart from their links, in order. Plain words when there is none.

`export function LinkedText`: The words of a line with its links drawn as links and its emote tokens as their pictures
(`Emote.tsx`, docs/chat.md "emotes"; bigger on a line of emotes alone). Nothing else is read
into the words: no markdown, no mentions. A link on this origin is a router link; any other
opens in a new tab through `ExternalLink`, which while the links setting asks for it first
says which site you are leaving for. The chat's lines and a direct message's are drawn
through this.

## `frontend/src/shared-components/LiveMark.tsx`

`export function LiveMark`: The red broadcast mark: a 16px box in `decrease` with the icon the inbox gives a go-live
(Notifications.tsx), drawn white on it. In the chat it stands beside the streamer's name
(ChatPanel.tsx); on a face, the presence square says it instead (PresenceSquare.tsx).
`className` places it; everything else (`title`, a label, a data attribute) goes on the box.

## `frontend/src/shared-components/MakeGroupDialog.tsx`

`export function MakeGroupDialog`: The dialog that makes a group (docs/groups.md): the name, the word on the badge, a colour,
a line about it, public or private, and the banner and the picture, each through the crop
dialog and shown here as they will sit on the group. `make it` posts the group, puts the
pictures on it, and goes to the new room. Home and `/groups` open it, for a login under the
cap on owned groups (`groups_per_owner`, the api's); past it the api says so here.

## `frontend/src/shared-components/MicMeter.tsx`

`export function MicMeter`: The mic's level, in the picture's top left corner while the stream is up: a dark chip with
a bar in it that rises with every word and falls more slowly, so the streamer can see the
mic is picking them up, and how loud. Many readings a second, so the bar is drawn by hand
from a frame loop (`mic-level.ts` reads, this paints) and never through react; only the
state words (hollow and struck through, `mic muted` or `no mic` on hover) are state. Not a
control: there is nothing here to press.

## `frontend/src/shared-components/MiniPlayer.tsx`

`export function MiniPlayer`: The corner players, rendered once by the router's shell so they survive every route change,
and so does where you put them. One shows at a time: your own stream while it is on air
(the watch page's picture in picture button is disabled then), else the stream you watch
(start on the go live page ends it). Each sits at the bottom right corner until dragged,
then stays where it was dropped.

## `frontend/src/shared-components/MobileSheet.tsx`

`export const SHEET_SNAP`: Let go past this share of its height and a sheet shuts.

`export const SHEET_FLICK`: A flick down this fast (px per ms) shuts it, however short.

`export const SHEET_MS`: The slide, up or down. Matches `sheet-up` in globals.css.

`export const SHEET_DIALOG`: A native `<dialog>` as a phone's sheet: the browser's centring and size caps go, it sits on the
foot of the window at its full width, no taller than 90% of it, its top edge the one stroke.
Paired with `data-sheet` (the slide up, globals.css) and a `SheetGrab` first inside it. With the
keyboard up it sits on the keyboard (`--kbh`, keyboard.ts), no taller than what it leaves less
24px of the dim page to tap it shut, and the keyboard covers the home bar, so no safe area under
its last row. The box in use is scrolled into sight inside it (keyboard.ts, `reveal`).

`export const PAGE_DIALOG`: A native `<dialog>` as a phone's page over the page: the whole of what the keyboard leaves of
the window (`--vvt`, `--vvh`, keyboard.ts; the whole window without one), no margins, no caps,
no stroke. Its close is `SHEET_CLOSE`.

`export const SHEET_CLOSE`: A close in a dialog's corner, on a phone: a finger's 44px square.

`export function SheetGrab`: The bar a sheet is pulled down by, first thing in it, a phone's only: the sheet follows the
finger (its own transform, no render per move), and let go past `SHEET_SNAP` of its height,
or flicked, it slides the rest of the way out and `onDismiss` takes it off. Anything less and
it springs back. The sheet is the nearest `[data-sheet]` up from the bar.

`export function useSheetBack`: The browser's back button shuts this sheet or page while it is up, on a phone, instead of
leaving the page under it. `dismiss` is how it shuts any other way (a dialog's `close()`).

`export function focusOnOpen`: A dialog just opened with `showModal()`: the caret goes in its first box (`selector`) on a
desktop. On a phone it does not: that raises the keyboard while the sheet is still sliding up,
and iOS pans the page to the box, so the sheet reads as a box floating mid-window, a desktop's
modal, until the keyboard goes. There the keyboard comes when a box is tapped, so a box that
`showModal()` focused on its own is let go too. Read straight from the window, for the layout
effect that opens the dialog.

## `frontend/src/shared-components/ModTab.tsx`

`export function ModTab`: The mod tab, on my own page only (docs/jannies.md): my stream's jannies (found by name and
added in one pick, removed from the list under the box), who is banned or timed out of my chat
(lift either), and the log of what was done in it, filtered by kind or to what still stands. A
janny deletes, bans and times out from the chat's lines; this is where the streamer keeps the
list. Beside them, what Eques says to each viewer who opens my chat. Two columns from md, one
card under another on a phone.

## `frontend/src/shared-components/Notifications.tsx`

`export const COUNT`: The number on the bell: the sidebar's blue square, as its counts have it.

`export function NotificationsBell`: The bell at the right end of every page's title row, before go live: the login's inbox
(docs/notifications.md), with how many are new on its corner. A click opens the list under
it (Notifications, mounted by the Shell) and closes it again.

`export function Notifications`: The list under the bell. Renders nothing until the bell is pressed.

## `frontend/src/shared-components/OAuthButtons.tsx`

`export function ProviderIcon`: The provider's mark, or a plain one for a provider this build has no icon for (infra/oauth.ts).

`export function OAuthButtons`: "or continue with" Google / Discord, under the log in and sign up forms. Only the providers the
api turned on (their env vars are set); none, and this is nothing at all. Plain links: the
browser goes to the provider and comes back to /oauth (OAuthPage.tsx), then to the page it
left. A provider login nobody here has asks for a name first; a known one logs straight in.

## `frontend/src/shared-components/OAuthMark.tsx`

`export const OAUTH_MARK_WORDS`: What the mark means, in the tooltip and the security tab. Any provider counts (api/src/oauth.rs `linked_sql!`).

`export function OAuthMark`: The verified mark: the account has an outside login linked (Google, Discord, any provider the
api adds later). Beside the ✓, which says only that the name has an account. Blue, a badge,
so the two never read as one.

## `frontend/src/shared-components/OfflinePicture.tsx`

`export function OfflinePicture`: The picture shown where a stream would be while the name is not streaming: their offline
picture (WatchPage.tsx, ProfilePopup.tsx), dimmed and lightly desaturated so it does not read
as a live frame, with the word over it saying so. The wrapper is `relative`, so the word's `absolute`
has its place inside this box.

## `frontend/src/shared-components/PageFrame.tsx`

`export function HomeLink`: Back to the stream list, to the left of a page's title: a caret alone, named `home` for
screen readers and for nobody else. The one icon without a tooltip (tooltips.mdc): the row
is pinned to the window's top edge, so above the caret there is no room for one, and under
it is the page. A crash reloads the document, because the router may be what broke. The
tests click `header a[href="/"]`. `square`: a 40px box, the size of the face beside it in a
stream's row (`person`).

`export function PageFrame`: The page's title row and its width. One row: back and the title on the left, the bell and
go live on the right. Sticky: the row stays at the top of the window while the page scrolls
under it (the page's own colour, so what scrolls under is hidden). The row is 4rem, and more
when the title and the actions do not fit on one line (a phone, a tablet with a long title,
a laptop at a larger text size): its height is measured into `--title-row` on <html>, which
globals.css makes the page's `scroll-padding-top`, so scrolled-to things land under the row
and not behind it, and which the room page sizes itself by (ServerRoom.tsx). Without a title
(home) the row is the bell and go live alone, exactly 4rem (the variable is not set; 4rem is
its fallback), and the page starts at the row's top rather than under it: home's part
headings are sticky and 4rem tall too (HomePage.tsx), so the one for the part you are in
stands at the row's left end, and the next part's pushes it out. Who you are is not here:
the sidebar is mounted once by the router's Shell, beside this column.

A phone's row is its own (below 768px, mobile.ts): the menu (the sidebar's drawer) at the left
on every page, `mobileStart` beside it, then where you are on one line, cut with an ellipsis
when it is long: `mobileTitle` or the title, or on home the part you have scrolled to
(`useCurrentPart`), whose headings then scroll with the page under the row; with `mobileSub`
the title is smaller and that line sits under it, in the same height. Then home (every
page but home) just left of go live, or just left of `mobileEnd` (a group's pins and drawer opener), as a back caret;
on a page with neither, and no go live of its own, home stays beside the menu (go live passes an empty
`mobileEnd`: its home is at the right end). No bell: a phone's is in the sidebar's drawer, beside the gear
(UserPanel.tsx). Always measured into `--title-row`, home's too: the page starts under it.
`bleed` takes the page's padding away, so what is under the row reaches the window's edges.

## `frontend/src/shared-components/Panel.tsx`

`export function panelClassName`: The one look every box has: a 1px stroke on the secondary background, no shadow (the home
page's stream cards and the corner player have the same). The chat, the status section, the
friend chat window. `interactive` turns the stroke blue on hover and keyboard focus for a
box that is a link.

## `frontend/src/shared-components/PersonCard.tsx`

`export interface CardAction`: A button in the moderator's box on the card (GroupMod.tsx `useCardMod`): an icon, its name the tooltip, red when it removes someone.

`export interface PeekHold`: The card's side of `usePeek`: while the pointer or the keyboard is on it, or something on it is held, it stays.

`export interface CardPerson`: Enough of somebody for the card. The sidebar's rows and the chat window's tabs hold all of
it; a chat line holds the name, the ✓ and the picture, a group's roster those and the word,
and the card asks the api for the rest.

`export interface CardSpot`: Where the card goes: level with the row pointed at, beside the column the row is in.

`export function usePeek`: The hover and focus bookkeeping for the card over one row. `show` measures and shows after
`delay` (a panel that widens on hover has settled by then, and a pointer crossing rows does
not flash a card per row). The card can be pointed at: it stays while the pointer is on the
row or on it, and goes `LINGER_MS` after it has left both (time to cross the gap), and stays
whatever the pointer does while something on it is held (`hold.pin`: a slider dragged). The
keyboard reaches it too: tab from the row goes into its buttons, tab off either end comes
back, and escape on either closes it. Only a mouse's hover or a focus that no tap left shows
it (`peeking`): a phone's tap opens the profile sheet, as before.

`export function PersonCard`: Somebody, beside the column their row is in, while the pointer or the focus is on the row:
the face with the presence square on its corner, and beside it, as tall as the face, the name
(cut short with an ellipsis) along its top and along its bottom their group's badge (the
primary group, else the first joined; none for no group) then, while they stream, how many
are watching, home's count (homeStreamsAtom; nothing until home has had the list). With
neither the bottom is empty and the name stays at the top. Then their status under the two.
Not streaming, their first home-card thumbnail stands there instead at the same size (a grey
box when they have none).
Streaming, a frame of the stream (StreamStill.tsx, kept a few seconds old) stands between
the name and the status, the card's width: the preview of what they are streaming, the
sidebar's small one made big. The sidebar's rows, the chat window's tabs, a chat line's
speaker and a group's roster (ServerRoom.tsx) all show it. A row (the following list, a
search's hits, the open chats) holds the word and the presence, so those are up at once; a
chat line holds the name, the ✓ and the picture alone, a roster's row those and the word. The
rest (the badge, the thumbnail, what a row lacks) comes from one `GET /api/streamers/:name`
asked whenever the card shows (follow-atoms keeps the answer a while, so hovering the same
name again asks nothing). Until it answers, or when it does not, what came from the row is
all there is: a chat line's card has no square and no status. The pointer can cross onto
it and the keyboard tab into it (usePeek), for a moderator's box and `below`. Drawn into the body
(no list clips it, and a window's transform does not move it), it goes out on the side away
from the edge, kept on screen, and hangs down from the row in the top half of the screen and
up from it in the bottom half.

## `frontend/src/shared-components/PersonRow.tsx`

`export function Who`: A name, its ✓ when it has an account, the verified mark when the account has a provider linked.

`export function Word`: The square and the word, the colours of docs/status.md. `square={false}`: the word alone, where the face beside it already carries the square.

`export function PersonRow`: Somebody, as a link to their watch page: the face with the presence square on its corner,
the name with its marks, the word beside it. One shape wherever a person is listed (the
search, home's people and recently offline).

## `frontend/src/shared-components/PicturePick.tsx`

`export function PicturePick`: The way to a new picture, on the picture itself: the whole picture is the click. Sits over a
picture in a `relative` parent with a named group (`group/x`). With the pointer over it
(`reveal`: the parent's `group-hover/x:opacity-100`), or the input in keyboard focus, the
picture greys and a camera sits in the middle of it. A screen with no hover gets the camera
small in the corner instead, all the time, and no grey (`icon` is the camera's size: smaller
on a small face, so it does not cover it). `label` is the input's name and the tooltip. The
crop dialog takes the file from here. The group's pictures, your own picture and the offline
picture are all changed this way; a remove, where there is one, is a word beside the picture.

## `frontend/src/shared-components/PresenceSquare.tsx`

`export type PresenceStatus`: What the square shows. The four presence words; `presenceStatus` maps a choice onto them.

`export function presenceStatus`: A choice as others see it: `invisible` is `offline` to everyone but its chooser.

`export function PresenceSquare`: Every presence indicator on the site (.cursor/rules/presence.mdc). One square per state, no icon:
only the colour says which, so nothing beside it moves when the word changes. Streaming is the
square cut on its diagonal, green over blue; nothing in it moves.

## `frontend/src/shared-components/ProfileLink.tsx`

`export const profilePath`: Their page (WatchPage.tsx).

`export function useShowProfile`: Somebody, from something that is not a link (a chat window's tab): them over the page
(ProfilePopup.tsx) while this browser's setting says so (settings.profilePopup), else their
page. `popup` is the setting, for an `aria-haspopup`; with it off, the thing spreads
`usePrefetchOnPointerDown(profilePath(name))` on itself, the way a link to the page is
prefetched (infra/prefetch.ts).

`export function ProfileLink`: A link to somebody's page (a group's roster, a direct chat's name). A click on it shows them
over the page instead (ProfilePopup.tsx), unless this browser turned that off
(settings.profilePopup): then the click is the link's, as is a click with a key held either
way (the browser's own: their page in a tab of its own).

## `frontend/src/shared-components/ProfilePopup.tsx`

`export function ProfilePopup`: The profile popup (docs/follows.md): somebody's page over the page you are on, discord's
way. A click on a member of a group's roster, or on a name in a chat, opens it while this
browser's setting says so (settings.profilePopup, the chat tab's `people` cards: on unless
turned off, and then the click does what it did before). Mounted by the Shell; it renders
nothing until `openProfilePopup`.

## `frontend/src/shared-components/Reactions.tsx`

`export function ReactionPicker`: The button that opens the reaction picker, and the picker: a quick row of the first `QUICK`
emoji, then the whole grid (reaction-list.ts `EMOJIS`, the api's list). Drawn into the body (or the
open `<dialog>`), under the button or over it when the window's foot is too near, the `more`
menu's way (ChatLine.tsx `MoreMenu`). The arrows walk the grid, escape closes it, a pick closes
it. An emoji already yours is lit, and picking it takes it off; with `MAX_KINDS` different on the
line, the ones not there yet are out of reach and the picker says why. `trigger` is the button's
look: the action bar's icon (`className`) or the chip row's add chip.

`export function ReactionChips`: The reactions under a line, discord's chips: the emoji and how many, lit (`outline`, the blue)
where one is yours. A click puts yours on or takes it off; the tooltip says who reacted. `onReact`
absent (a nick in a stream's chat): the chips still say who, and a click asks to log in through
`onBlocked`. The last chip is the picker again, there while the line is pointed at (always on a
screen with no hover).

## `frontend/src/shared-components/Reorderable.tsx`

`export function movedTo`: `order` with `key` taken out and put back at `to`, stopped at the two ends. The same array when nothing moves.

`export function useReorder`: A list reordered by a drag handle at each row's left end (reorder.mdc). The pointer drags a
row (mouse and touch alike: the handle is `touch-action: none`, so a finger on it does not
scroll the page), and the keyboard does the same on the handle: space picks the row up, the
up and down arrows move it, space drops it, escape puts it back where it was. A polite live
region says where it is. The list element takes `list`, each row `item(key)`, each handle
`<DragHandle {...handle(key)} />`, and `status` goes beside the list in a `relative` parent.

The list holds the pointer, not the handle: a dragged row is taken out of the document and
put back by the reorder, and the browser lets go of a node that leaves. The drag ends with
the capture, whatever ends it. One drag at a time, by the pointer that began it.

`export function DragHandle`: The handle at a reorderable row's left end (reorder.mdc): `useReorder`'s `handle(key)`, spread on.

## `frontend/src/shared-components/SceneView.tsx`

`export type LayerKey`: What a layer does under the keys besides moving: taken off the stream or out, sent back or brought forward.

`export interface SceneEdit`: The editor's hooks. Given, the layers can be taken hold of; without them the frame is a watcher's.

`export interface MainVideo`: The one `<video>` with the sound: the watch page's `#video`, the go live page's `#preview`.

`export function SceneView`: The frame as the streamer laid it out (docs/screen.md): a 16:9 box with the layers drawn in
it, bottom first, each at its own fractions, so this preview and every watcher's player show
the same picture at any size. The main `<video>` (the one with the sound) stands in for the
first video layer of its slot and never unmounts: the other video layers are muted copies,
the pictures `<img>`s, the avatar the streamer's picture moving with the sound (`AvatarLayer`).
A watcher clicks a video layer to see it alone; the streamer takes hold of a layer to move
it, pulls a corner to resize it, and uses the keys (arrows nudge, shift five times as far,
delete takes it off, `[` and `]` move it through the stack, escape lets go).

## `frontend/src/shared-components/Select.tsx`

`export interface SelectOption`: One thing to pick: what a pick says, and the words for it.

`export function Select`: A box that picks one of a few options: the one that is on, and a list of them all that opens
under it. The site's own, drawn by the page, so it is the same box in every browser. The
browser's select is not used anywhere: its open list is the operating system's, round and
glossy on a mac, another thing again in each browser, and no css reaches it
(.cursor/skills/no-native-select).

A click opens and shuts it. So do the keys, the way a select's do: enter, space or an arrow
opens it on the option that is on, the arrows, home, end and the page keys walk it (past
what cannot be picked, stopping at the ends), enter or space picks, escape shuts it and
changes nothing (a dialog it is in stays open), tab picks and moves on, and letters typed
go to the option that starts with them. A press anywhere else, or the focus leaving, shuts
it unchanged. The option that is on is blue and ticked.

The keyboard's focus stays on the box the whole time (`aria-activedescendant` says where the
keys are), so nothing in the list is focused and no pane scrolls to it. The box is a `div`
that takes the focus, not a `button`: safari leaves a button out of the tab order unless a
setting is changed, and does not focus one on a click, and a select has neither fault.

The list is drawn into the body, `fixed`, so no pane clips it and it sits over every panel,
and it follows its box through a scroll or a resize; inside a modal dialog it is drawn into
the dialog instead, since nothing in the body reaches the top layer (the tooltips' way). It
goes under the box, or over it where there is more room, is as wide as the box at the least
and as its longest option at the most, and scrolls past 240px. It wears the box's type size.

## `frontend/src/shared-components/Skeleton.tsx`

`export const BONE`: The grey a thing is before it has arrived: the tertiary background, breathing. Hard edges,
like every box here, and still under reduced motion. On a block, never on a border: a stroke
that fades reads as the box going, not as what is in it coming.

`export function Bone`: One grey block the size and shape of what is coming: give it the height and the width.

`export function Skeleton`: What stands where a thing will stand while it is asked for: the same box, the same grid,
grey. So the page has its shape from the first paint and nothing moves when the answer
lands. Marked busy, and named, so a screen reader knows what the grey is.

## `frontend/src/shared-components/Socials.tsx`

`export const SOCIAL_ICON`: The icon for each kind: the brand's mark, filled, the way it is recognised small; a globe for any other site.

`export const SOCIAL_ICON_PX`: The icon at each size. 16 and 28 are the scale the rest of the page uses; 40 is the one size past it, for a row of buttons a thumb can hit.

`export function Socials`: Where else to find them (docs/socials.md): their links as icons, in a line that wraps or as
a grid of squares, at the size they picked. Every link leaves this origin through
`ExternalLink` (a new tab, the word first while the links setting asks), its host in the title so
a hover says where a `twitch` icon really goes. The watch page's tab, where the owner's
editor opens under it on the draft. `data-layout` and `data-size` are for the tests.

## `frontend/src/shared-components/SocialsEditor.tsx`

`export function SocialsEditor`: The links' editor (docs/socials.md), on the owner's own page under the strip it edits: the
rows, the places to add one from (a square per kind: click it and a row of that kind appears
with its url box focused), how the links sit and how big, and one `save links`. The strip
above follows the draft as it is typed, so there is no preview of its own. The draft lives
in profile-atoms, so the editor can fold away and open again on it; one `disabled` over the
whole thing with `whyNot` in the status, the presence block's shape.

`export function SocialsTab`: The socials tab under the player (docs/socials.md): a line saying when they joined (an
account's `created_at`, the month; the day on hover; nothing for a free name, which nobody
joined), the strip, and on my own page the editor under it. While the editor is open the
strip is the draft as the save will keep it (a row that is not a link yet is left out), so
what is being edited is what is on the page; `done` folds the editor and the strip is the
saved document again (the draft is kept for the next time). Opening it loads my profile, so
the draft and the api's rule are the name's I am.

## `frontend/src/shared-components/StatusLine.tsx`

`export function StatusLine`: The one big line that says what is going on. Short words, high contrast, read aloud by screen readers.

## `frontend/src/shared-components/StreamStats.tsx`

`export function StreamStatsButton`: The stream's health, in the picture's top left corner: a dark chip with signal bars in it.
While the picture is actually in trouble it is up on its own, red, the bars struck through
(a chip glyph instead when the streamer's cpu is what limits it); otherwise it comes and goes
with the other controls, on hover and keyboard focus, so the numbers stay a click away.
Hover and keyboard focus show the quality line under it; a click opens the numbers and a
click again, Escape, or a press outside closes them. It is not a setting: a watcher gets the
one picture the box has (docs/bitrates.md), so there is nothing here to choose.

## `frontend/src/shared-components/StreamStill.tsx`

`export function StreamStill`: A frame of `name`'s stream, a few seconds old: `GET /thumb/<name>.jpg`, the picture video's
ffmpeg writes beside every live stream (docs/spec.md). Asked again every 5s while on screen,
each new frame fetched off screen first and swapped in once it has arrived, so the picture
never blinks to nothing between two. Not there (a stream younger than ~6s has no frame yet)
or gone stale (video says 404 rather than serve a frozen frame as live): the box alone,
black, until the next ask. A still whose own document is hidden asks nothing: the tab's, or
the popped-out player's window's (PersonCard.tsx mounts the card in the row's document), each
on its own. For a name that is streaming: the one showing it decides that (the sidebar's row
and the person card, on `presence`).

## `frontend/src/shared-components/StreamTile.tsx`

`export function StreamTile`: A small picture of one slot: a shared screen beside the camera, or the camera beside a
shared screen. 16:9 at 160px with its name in the corner, like the cards' chip. The watch
page's tiles are buttons that make their slot the big one; the live page's carry a stop.

## `frontend/src/shared-components/SwipeDrawer.tsx`

`export function DrawerClose`: A drawer's way out, for its head: a 44px ×, named `close`. The dim sliver and Escape shut it
too, but a finger needs something it can see.

`export function SwipeDrawer`: A phone's drawer (below 768px, mobile.ts): a panel 90% of the window's width that slides in
from one side over the page, the 10% left over the page dimmed. A button opens it (the menu
at the left of the title row, a group's at the right), never a swipe in from the edge: the
left one is the browser's back swipe. A tap on the dim sliver shuts it, and so do Escape, its
own × (`DrawerClose`) and a swipe back toward its edge: the panel follows the finger and, let
go, shuts once it has come `SNAP` of the way (or was flicked). A swipe that starts mostly
down is a scroll and is left alone. The page under it does not scroll (globals.css,
`data-drawer-open`). The safe areas are the panel's padding: the top, the foot and the outer
side. Drawn into the body, over the page's sticky row, the friend chat and the players (z-50,
later in the document); a tooltip is over it (z-[60]).

## `frontend/src/shared-components/Tooltip.tsx`

`export type TooltipAt`: Which side of the children the tooltip goes on.

`export function Tooltip`: A tooltip: `content` beside the children while the pointer rests on them or the keyboard
focus is in them (not the focus a click leaves behind), 8px off, above unless `at` says
another side. When that side has no room in the window it goes on the opposite one instead
(the title row is pinned to the window's top edge, so above its bell there is none, and the
bell's goes under), and then it is pushed back in from the edges whatever the side.
Escape hides it. The children are laid out as if it were not there. The box is drawn into
the body, `fixed`, so no scrolling list clips it and it sits over every panel, and it follows
the children through a scroll or a resize; inside a modal <dialog> it is drawn into the
dialog instead, since nothing in the body reaches the top layer. Where this is used the
native `title` goes: two tooltips for one button is one too many. For the name of an
icon-only button on the page (the sidebar's chat and ×); over a video, VideoControls'
ControlTip is the one that reads on the picture.

## `frontend/src/shared-components/Turnstile.tsx`

`export const turnstileConfigAtom`: What the api said, `undefined` until it answered. An older api or a blip reads as off.

`export function useTurnstileOn`: Whether the widget is drawn, so a form waits for its token. False until the api answered.

`export function useTurnstile`: A form's side of it: the widget to draw, the token to send (undefined while off), whether the
submit may go (always, while off), and `spent` to call after each submit.

## `frontend/src/shared-components/TypeToConfirm.tsx`

`export function TypeToConfirm`: ConfirmDialog for the worst of them (deleting a group): the yes stays off until two random
words are typed back. The words are new on every open and cannot be copied or pasted, so
the yes takes reading them. Mounted = asked, portalled onto the page like ConfirmDialog: a
modal inside a modal closes the outer one with it.

## `frontend/src/shared-components/UserModal.tsx`

`export function UserModal`: The user modal: who you are and how this browser shows things, the way discord does its
settings. A rail of tabs down the left (the account: profile, stats, groups, security,
notifications; this browser: appearance, chat, voice, sidebar, advanced; a phone has no advanced,
`tabsFor`), the open one's pane on the right. Mounted by the Shell; it renders nothing until `openUserModal`, and the page
behind follows every change at once, so the layout and theme cards are their own preview.
A native <dialog>: the browser keeps focus in it, closes it on escape and hands focus back
to what opened it; a click on the backdrop closes it too.

## `frontend/src/shared-components/UserPanel.tsx`

`export function DrawerOpener`: A phone's way into the sidebar's drawer (UserPanel below), at the left of every page's title
row (PageFrame.tsx): the menu glyph, a 44px square. Who you are is the drawer's head.

`export function UserPanel`: A column beside every page (left, or the right from settings). Collapsed it is only as wide as
the pictures, and the streams use the rest: the search box as its icon, then friends, the rest
of who you follow, and the groups you are in, a line between each, in the order settings put
them (Friends.tsx), you at the bottom. Hover or focus widens it
over the streams (the page does not move, and neither do the pictures): the box, and beside
each picture the name, how they are, unfollow, chat for a friend, and your actions. Logged
in: your account name and a ✓, and under it the badge you picked (`#you-badge`, your primary group's), none if you picked none. Not logged in: a name box (localstorage,
used in chat and as the go-live default) that reads as plain text until you point at it, with
sign up and log in under it. Nobody has to. At the far end of your row, boxed icons: the
messages (while that setting is on), a phone's bell, the gear, and log out. The picture, and a login's name, are the way to
your own page, `/watch/<you>`: your status, your about me, your links, your calendar as everyone sees them (the about me and the links are written there too); the
gear is the way to the user modal (profile, groups,
security, notifications; appearance, chat, voice, sidebar, advanced). The friend chat window opens
from a friend's chat button on their row (Friends.tsx). Go live is the right end of the page's title row.
The ids are the ones the tests key on; `data-open` says which state the panel is in.

## `frontend/src/shared-components/VideoControls.tsx`

`export const CHIP`: A control over the video.

`export const CHIP_BUTTON`: A chip that is itself the button: blue stroke and blue glyph on hover, like every button on the site, over solid black.

`export function ControlTip`: The hover name of an icon-only control. `group/control relative` is the control it hangs off.

`export function revealClassName`: The reveal of a controls bar. Hidden: faded and 4px low, and it waits 300ms before going (a
pointer that strays off the video for a moment does not make the controls blink); it comes
up at once on hover of the `group` around the video, while a control in it has keyboard
focus (not the focus a mouse click leaves behind, or it would stick), while one is expanded
(an open stats panel must not fade out from under the pointer), and on a screen with no
hover at all. `shown`: always up, no transition games.

`export function IconButton`: A 32px square chip with a glyph in it.

`export function PipIcon`: The usual picture in picture glyph: a screen with a small picture in its bottom right corner. Square, like the rest.

`export function PopOutIcon`: Out of the page: a box with its top right corner open, and an arrow leaving through it. Angular, like the rest.

`export function ChatIcon`: A speech box with its tail at the bottom left.

`export function SoundControl`: The speaker (mute, unmute) and the volume dial, one control. No box of its own, the way a
player's sound control usually sits straight on the picture: a shadow under the glyph and the
dial keeps them readable over a bright frame. Mute drops the dial to 0 and crosses the speaker,
unmute brings the level back; the dial dragged to 0 is a mute, dragged up from 0 an unmute. A
drag that ends on 0 went through every level on the way down, so the level when the dial was
taken hold of is kept for the way back (`settleDial`).

## `frontend/src/shared-components/VideoFrame.tsx`

`export function VideoFrame`: A <video> that follows a MediaStream atom. The binding uses `store.sub` from a mount-only
effect, the way imperative DOM updates are wired at the data source, instead of an effect
that reacts to the stream value.

## `frontend/src/shared-components/ViewerCount.tsx`

`export function ViewerCount`: How many are watching: different addresses receiving the stream, counted by video (docs/viewers.md).
Five tabs on one wifi are one. `data-viewers` for the tests.

## `frontend/src/shared-components/VisibilityToggle.tsx`

`export function VisibilityToggle`: Public or private, as an on/off switch: on is private. A 36x20 track with a lock on its knob
(open for public, shut for private), tinted blue when private, and the chosen word beside it;
the track and the word are one click. The make-a-group dialog, the room's manage dialog
(listing) and the user modal's groups tab all use it.

## `frontend/src/shared-components/VoiceLevel.tsx`

`export function useHeardUid`: `name`'s user id while you and they are in the same voice channel of the room on the page (and they are not you): the one whose level you can set. Else null.

`export function useHeardLevel`: `uid`'s level as you keep it (voice-atoms.ts `voiceHeardAtom`).

`export function HeardMutedMark`: The mark on a voice channel's row for someone you muted for yourself: nobody else hears a difference.

`export function VoiceLevel`: Your own level for `name`, someone in your voice channel: mute them for yourself, and their
volume from 0 to 200% (100 as they come), the percent beside it. Only what you hear: it is
applied to their line on the call as it moves (voice-atoms.ts `applyHeard`) and kept in this
browser by their id, so a rejoin and a reload keep it. At the foot of their hover card
(PersonCard.tsx `below`) and in a phone's profile sheet. `pin`: the card's hold, so it stays
while the slider is dragged.

## `frontend/src/shared-components/WelcomeEditor.tsx`

`export const WELCOME_TIP`: What the welcome is, by its title in both places.

`export function WelcomeEditor`: My chat welcome (welcome-atoms.ts), the editor: the bot Eques says it at the top of my chat to
whoever opens it, on their screen alone. The switch saves at once, with the words as saved; the
words save with the button. Under them, the line as Eques says it, the draft's words in the
chat's shape. In the profile tab and in my page's mod tab, the one set of atoms (profile-atoms.ts)
behind both, so a save in one shows in the other. `id` tells their elements apart; the caller
loads my profile (`loadMyProfile`) and draws the title.

## `frontend/src/shared-components/input.ts`

`export const INPUT`: A box to type in, everywhere: 30px tall (16px text on a snug line, 3px above and below), on the
page colour so it stands off a pane. A phone keeps the 16px text (globals.css): ios zooms in on
a smaller box when it takes focus. Add width extras with cn(INPUT, 'min-w-0 flex-1').

`export const INPUT_BUTTON`: A button in a row beside an INPUT (search, send, join): the same 30px, so the row stays flush.

## `frontend/src/shared-components/live/Collapsible.tsx`

The go live page's right rail is `Rail` in `app/live/LivePage.tsx` (`#live-rail`). It sits one 8px gap from the stage, with no
edge column. `#live-rail-edge` is an invisible strip over that gap and the rail's left border holding `#live-rail-resize`
(col-resize; resizes the rail between 220 and 480px, `settings.liveRailWidth`, `liveRailWidthAtom`; double-click or a cleared
value is the 244px default; arrows step 16px; tooltip `drag to resize · double-click resets`). At rest it draws nothing. On hover
or keyboard focus it shows `#live-rail-grip`, three dots on the border, and under it `#live-rail-toggle`, a small boxed chevron
that collapses the rail. While dragging, the grip and the line go `primaryBlue` and `#live-rail-size` reads `width / 480`.
Collapsed (`settings.liveRail` = `shut`; open until collapsed), the rail is `#live-rail-strip`, a 40px column of boxed icon
buttons built from each module's `strip` form: expand (`#live-rail-toggle`), thumbnail, start (one click to go live) and copy
link, presets, destinations (when the api has them) and layout at the bottom. A section icon calls `openRailAt(section)` in
`infra/live-dock.ts`, which opens the rail and sets `railFocusAtom`. `Rail` then scrolls that `[data-rail-section]` into view and
focuses its first control. The stage takes the freed width. Desktop only.
Its sections (studio, layout, presets, thumbnail) each fold to their header row through
`live/RailSection.tsx` (`RailSection`, `RailFold`), kept per browser in `settings.liveRailFolds`
(`liveRailFoldsAtom` in `infra/live-dock.ts`). The modules (sources, face, rigging, sound, chat)
do not fold: a preset or edit mode shows or hides them. Start stays out of the studio fold.

`export const ICON_BUTTON`: A small icon-only button in a panel's header or row: a square that gets the blue stroke on hover.

## `frontend/src/shared-components/live/modules/Presets.tsx`

`export function PresetsModule`: The go live page's presets: up to nine, each a saved stream setup (the sources, their
order, boxes, shown and fit, the levels, the sounds and the source settings; never the layout or the shown modules),
kept per browser in `settings.livePresets` (`infra/live-dock.ts`). Nothing is saved on its own: the header's save icon
(`#live-preset-save`, tooltip `save to <name>`) writes the current setup over the active preset, and its dot
(`#live-preset-dirty`) shows while the setup differs from it (`stageChanged` in `infra/stage.ts`, which ignores what a
reload changes by itself, and reads the levels where they live, the mixer or the kept mixer settings before it opens).
The `+` (`#live-preset-new`) makes a new preset from the current setup and opens its rename. The active preset is put
back on load. Rows reorder by their grip (`useReorder` with `hold`, so a touch needs a 300ms press and a quick swipe
still scrolls); keys 1 to 9 follow the order. Any preset deletes, default too; with none left, one `default` starter
stands in, drawn with the streamer's avatar (`Face`) and built from whatever is on the stage.

A saved screen share, or a saved camera the browser has not been allowed to open, cannot start without a click, so a
preset puts it back as a waiting source (`waiting` on `Source`): it keeps its place, size, order and settings, is never
sent to watchers, and draws as `live/WaitingLayer.tsx` in its slot, a `share` (or `camera`) button that opens it into
that slot.

## `frontend/src/shared-components/live/modules/Sound.tsx`

`export function MixerBody`: The sound panel, before going live and while live (docs/audio.md): a row for the mic (and
for any sound added later), each with its bar, its mute and its fader, and under them
`everyone hears`, the mix that leaves, with the same. The faders are what the watchers get;
nothing here plays on this machine. Before the mic opens the mic and `everyone hears` faders
still show and move, kept in `settings.mixer` until the mixer takes them up.

## `frontend/src/shared-components/live/ModelControls.tsx`

`export function ModelControls`: Under the sources while a model is in the camera's place (docs/vtuber.md). Its name, and at
the end of that line a light for the face reader: green while it reads a face, red with a
word or two beside it while it reads none (`no face`, `camera blocked`), grey and breathing
while it is on its way, with a bar under the name while its files still come down. The whole
sentence is the light's tooltip, with what of this model a face can move; a model with no
face says that on the page, since nothing else explains a face that stays still. On a
browser where a hidden tab stops the model, a mark beside the name says so.

Then the few things to set, as icons: `mirror` (the model moves like a mirror, or like the
person a camera sees), `expressions` (the brows and the smile move it too; only on a model
that has them) and the colour behind the model. In words: `rest face` (the face as it is now
is the resting one), which camera reads the face when there is more than one, another model,
and the way back to the camera's own picture, which asks first on a stream that is up:
watchers would see a face from there.

The reader's numbers ride on `#face-status` as data attributes (where the head is asked to
turn, the jaw, the blink, the smile, the brows, frames a second, and what kind of face the
model has) for the test, which reads those and never pixels. Its words are in it whatever
the light shows, for a screen reader and the test.

## `frontend/src/shared-components/live/ModelDialog.tsx`

`export function ModelDialog`: The model picker (docs/vtuber.md): the site's demo models, out of the bucket with one fetch
(a name, who made it, its licence and a thumbnail each), the streamer's own models that this
browser keeps, and a file of their own: a .vrm, a .glb or an .fbx. A pick loads the model and
puts it where the camera's picture goes; its card shows how far along it is, and the dialog
closes once it is on. A demo model comes down once: this browser keeps it, its card says
`downloaded`, and after that it opens with nothing to wait for. Their own file is read here
and kept here: it is not put up anywhere. Under that, a few sites that have models to
download, for someone with no file to pick.

## `frontend/src/shared-components/live/ModelLoading.tsx`

`export function readerWords`: The face reader on its way: its files coming down, then it starting.

`export function loadWords`: How far along a model is, in the streamer's words.

`export function loadWordsShort`: The same in a word or two, for a card too narrow for the sentence: the megabytes while they come, then what is being done.

`export function loadFraction`: How much of a step is done, 0 to 1. `null`: no telling (a step that counts nothing, or bytes of a whole nobody said).

`export function LoadBar`: A thin bar: filled as far as the step is done, or breathing when there is no telling how far that is.

`export function ModelLoading`: Over the preview while a model is on its way on (docs/vtuber.md): its picture, its name, a
bar and what is happening. A visit that comes back to a kept model would otherwise look at
an empty frame for as long as the file takes; a pick has the picker's card saying the same,
and this behind it for when the picker is closed before the model is on. It takes no
presses: the layers under it are still the streamer's to move.

## `frontend/src/shared-components/live/ModelPicture.tsx`

`export function LetterTile`: A model with no picture of its own: the letter its name starts with, on the colour its name makes.

`export function KeptPicture`: A kept model's picture: bytes out of this browser, shown through a url that lives as long as this does.

`export function ModelPicture`: A model's picture from what was picked, for where there is no card to take it from: a demo
model's thumbnail off the api (the letter when it has none, or the server is away), one of
their own's off this browser's shelf. Keyed by the model where it is used: what it learnt
about one model's picture is not true of the next.

## `frontend/src/shared-components/live/Rigging.tsx`

`export function Rigging`: The rigging, under the preview while a model is on (docs/vtuber.md): what the face reader
sees and what it makes of it. The camera's picture with the reader's points on it (the mesh
faint, the face's outline, the eyes, brows and lips in the accent, the irises green), and
beside it the numbers those points become, which are what move the model: how open the
mouth is, how shut the eyes, the smile, the brows, and the head's turn, nod and tilt.

This is the one place the camera's own picture is shown, and it is this page's alone: the
track is in no sender (`readerCameraAtom`). The picture is always under the marks (no eye: Billy wants
the face video and the rig together); while a screen is shared it is hidden, since a share of this page would carry it out. Hidden from before the browser's picker
opens (`screenMaySeePageAtom`): once a screen is shared its first frames are already sent.

## `frontend/src/shared-components/live/Sources.tsx`

`export function StartStop`: The foot of the panel: start, or stop once the stream is up, the width of the panel. A guest
with no name yet is told so under it, with the way to the profile tab, where the name is
picked (there is no name box on this page: a login streams as its account, anyone else as
the nick in the corner panel). While live, `share screen` beside stop, the same press as the
`+` menu's `screen or window`; not where the browser has no screen capture (phones). A
phone's go live page puts it beside the status under the preview instead (LivePage.tsx), in
a box of its own `className`.

`export function Sources`: The sources, beside the preview: the camera (or the avatar standing in for it, mic only),
the shared screens and the pictures, top of the stack first (the row order is the reverse
of the array, the way a layers panel reads). Each row selects its layer; the handle at its
left end drags it up or down the stack; the eye puts it on or off the stream; `×` stops a
share, removes a picture or the avatar, turns the camera off. The `+` adds. Folded, it is a
rail, with start (or stop) still at its foot. With a model in the camera's place
(docs/vtuber.md) its face reader's words and controls sit under the list, and the picker is
this panel's to open: from the `+`, and from `another model`. `startStop={false}`: no foot,
the page has start and stop somewhere else (a phone's, LivePage.tsx).

## `frontend/src/shared-components/reaction-list.ts`

Reactions (docs/chat.md "reactions"): the emoji a line may wear, and what the pages do with the
frames that change them. The api allows these and no others, in this order (api/src/reactions.rs
`EMOJIS`; a test there reads this list), so the picker never offers one it would refuse. A
reaction may also be a group's custom emote, by its id (emotes.ts `isEmoteId`), for a reactor
in that group; the picker offers the login's own (Reactions.tsx).

`export const EMOJIS`: The picker's grid, the first `QUICK` of them its quick row.

`export const EMOJI_NAMES`: Each emoji's name: its button's label and tooltip, and the words a chip's reader hears.

`export const QUICK`: How many of `EMOJIS` stand in the picker's quick row.

`export const MAX_KINDS`: Different emoji on one line, at most (reactions.rs `MAX_KINDS`): the picker says so past it.

`export interface Reaction`: One emoji on a line: how many put it there, and the first of them by name (25 at most, reactions.rs `NAMES_SHOWN`), in the order they came.

`export function reactionsOf`: A line's reactions as the wire had them: only well-formed ones, none for an older api.

`export function applyReaction`: `who` put `emoji` on a line, or took it off (`on`): the line's reactions after it. Said twice, the
second is no change (a reaction between a history and its socket's first frame comes in both). A
name past the first 25 is not in `who`; its count still moves. `me` is the login reading: their
own change sets the reaction's `me`, and their own twice is known by it even past the 25.

`export function whoReacted`: Who put `r` there, in words, for its chip's tooltip: `you, bob and 3 others reacted with 🔥`.
You first when you are one, then the names in the order they came, then how many past those.
`glyph` is how the reaction reads: the emoji, or a custom emote's `:name:`.

`export function reacted`: Whether `me` is among those who put `r` there: the api's word for it, or their name among the shown.

## `frontend/src/shared-components/user-modal/AdvancedTab.tsx`

`export function AdvancedTab`: The rest of this browser's settings: the ones for looking under the hood. The messages
inspector (docs/status.md): the frames this browser gets, in the browser. A shared worker's
socket does not show in a tab's devtools, and a phone has no devtools.

## `frontend/src/shared-components/user-modal/AppearanceTab.tsx`

`export function AppearanceTab`: The theme: a preset, or colours of their own. Picking applies and keeps at once, so the page
behind is the preview; the derivation keeps the text readable whatever the picks, and dark
is one click away. And the size: how big the whole page is, in five steps. Kept in this
browser, like the layout.

## `frontend/src/shared-components/user-modal/ChatTab.tsx`

`export function ChatTab`: This browser's settings for the chat: where it sits on the watch page and the go live page,
where it opens on the corner player, whether the bots' lines show, the shape of the lines in
every chat (a stream's, a group channel's, a friend's), what a click on somebody in a chat or
in a group's roster does, whether a link asks before it opens, whether a video link gets a
player. The chat behind the modal
follows every change at once, so the cards are their own preview.

## `frontend/src/shared-components/user-modal/GroupsTab.tsx`

`export function GroupsTab`: Groups: the ones I am in, as home's squares. A click makes one my primary (my name then wears
its badge alone), a second click unsets it. On a desktop a hovered or focused square has an x
to leave; a phone leaves from the group's page. Joining, making, deleting and the public or
private switch are the groups pages' (MakeGroupDialog.tsx, ServerRoom.tsx); `bot` is automatic,
so it is not here. Every change says hello to the open chat again, so the badges follow at once.

## `frontend/src/shared-components/user-modal/NotificationsTab.tsx`

`export function NotificationsTab`: Which kinds go in the inbox (docs/notifications.md): four switches, kept with the account
through the api, so every device agrees. The bell at the top right of every page is the
inbox itself; this tab is only what is put in it. Nobody sees the pointer to an account.
A switch stays disabled until this login's settings have been applied, so a click cannot
save the default. A channel is muted one at a time on the room page; the switch here is
every group's channels at once.

## `frontend/src/shared-components/user-modal/ProfileTab.tsx`

`export function ProfileTab`: Who I am, as others see it: the picture, the name, the status. For a login the name is the
account's and fixed; for a guest it is the nick, kept in this browser, and changing it is
becoming somebody else (the old name keeps its status and picture). Everything saves under the
name I am now, through the api's one rule: a free name is anyone's, a claimed one its login's.
The links are not here: they are edited on my own page, where they show
(SocialsEditor.tsx); this tab points there.

## `frontend/src/shared-components/user-modal/SecurityTab.tsx`

`export function SecurityTab`: The account. Nobody has to have one; with one the name is yours. Logged out: log in or sign
up, right here (the /login and /signup pages are the same form with a place to go after).
Logged in: a new password (or a first one, for an account made with a provider), the linked
Google / Discord logins (which make the account verified), and the ways out. No email reset
yet: the words say so.

## `frontend/src/shared-components/user-modal/SidebarTab.tsx`

`export function SidebarTab`: This browser's settings for the column beside every page (Friends.tsx, docs/follows.md):
which side it sits on, and which of its lists it shows in what order. The column behind the
modal follows every change at once, so the cards are their own preview.

## `frontend/src/shared-components/user-modal/StatsTab.tsx`

`export function lengthWords`: `1h 23m`, `12m`, `40s`.

`export function StatsTab`: Stats: what my streams did, for me alone (docs/analytics.md). The range's numbers as tiles (7 or 30
days, boxed chips), the viewers of one stream over time as a line (the last one, or the one picked
from the list under it), and that stream's tiles. Nobody logged in: a stream with no account is
not recorded, so the tab says to make one, with the security tab's sign up as the way.

`export function ViewerGraph`: Viewers over time, one line, inline svg (no chart library). One series: the title names it, no
legend. The line is the theme's blue at 2px, the grid recessive. A hover or a finger shows the
minute and its count with a crosshair; a screen reader gets the same points as a table.

## `frontend/src/shared-components/user-modal/VoiceTab.tsx`

`export function VoiceTab`: The devices a call uses: the mic it talks with, the speakers it plays through, and the camera
it shows (voice-video.ts); then what is done to the mic (isolation, echo cancellation, auto
gain) and how it opens (voice activity's gate, or push to talk). Everything applies at once,
to a call that is on too, and keeps in this browser (voice-atoms.ts). The mic's level shows
live while the tab is open: the tab holds the one mic a call would use (the call's own while
in one), and lets go of it when it shuts.

## `frontend/src/shared-components/user-modal/parts.tsx`

`export const SECTION_TITLE`: The small label every block starts with.

`export const FIELDSET`: A block of a tab that is one set of choices: a fieldset, its legend the small title. The legend
floats, so it no longer sits on the rule `divide-y` draws above the block and cut a gap in it.

`export const BUTTON`: The buttons in a pane: a size down from the page's.

`export const CHECKBOX`: A square to tick: the theme's box, blue when on.

`export function Section`: One block of a pane. The parent is `divide-y divide-primaryStroke`, which draws the rule between blocks.

`export function Info`: An ⓘ that says the rest of what a title means, on hover and focus.

`export function Block`: One block of a settings tab: the small title, an ⓘ for the rest, the controls. The parent is `divide-y divide-primaryStroke`.

`export function Field`: A label over a control, a hint under it. The control carries `id`, and `aria-describedby={`${id}-hint`}` when there is a hint.

`export function PasswordInput`: A password box with an eye inside to show or hide it. The security tab's and the profile tab's.

`export function Status`: What the last action did, read aloud. Always rendered: a live region announces only text that arrives after it exists.

`export function OptionCard`: A radio as a card: the chosen one has the blue stroke (no shadow) and says so in words too.
`relative`, so the sr-only radio (position absolute) is placed inside the card. Without it the
input's containing block is the pane wrapper outside the scrolling tabpanel: a card low in the
pane puts its 1px input past the dialog's bottom edge, and the click that focuses it scrolls
the overflow-hidden dialog down to it, taking the rail and the pane out of view.

## `frontend/src/shared-components/ChatPanel.tsx`

`export function pictureSrc`: Where a chat picture is fetched from, by the id `POST /api/chat-images` handed back.

`export function ChatImages`: The pictures on a line, under the words. One is drawn as it is, at most five lines tall. Two
sit side by side. More make two rows, the first with the odd one out, and the pictures of a
row share its width, cropped to fill their cells: three are two over one across the whole row,
five are three over two, eight are four over four. A click on any puts it over the whole page
(`PictureView`), in the window the chat is in: the page's, or the popped-out player's own.
A direct message's pictures are drawn by the same (FriendChat.tsx), and so are a pinned line's in
a group channel's pins list (ServerRoom.tsx), `small` there: rows 4rem tall, one picture at most
5rem, to sit in the narrow list.

`export function EquesLine`: Eques's line itself, in the lines' shape, whatever the switches say: the chat's welcome, and its preview in the welcome editor (WelcomeEditor.tsx).

`export function RoomLines`: A room's lines in the shape this browser picked, each as the panel draws it: the panel's
list, and a group channel's pinned lines in a phone's sheet (PinSheet.tsx). `name` is the
panel's: whose lines are `mine` is said against it. Each line has the action bar (ChatLine.tsx
`LineActions`): react where `reacts` (the panel's own list, not a pin's copy: a login picks an
emoji, a nick is told to log in), reply where `replies` (the panel's own list once it can speak),
the caller's own buttons (`lineActions`), and `more`; `lineSide` puts buttons in a column of
their own at the line's right (the sheet's jump and unpin). A reply wears the quote of its line, a
click on which goes there where `jumps` (`ChatRoom.jumpToReply`); a line's reactions stand under
it as chips (Reactions.tsx `ReactionChips`), a click on one putting yours on or off.

## `frontend/src/shared-components/ChatVideoPlayer.tsx`

`export function ChatVideoPlayer`: The video on a line (docs/chat.md "videos"): the browser's own player, its poster the frame the
sender's page grabbed, no bytes asked for until a press on play (`preload="none"`), never
playing on its own. As tall as a picture is at most, five lines (`max-h-[7.5rem]`), or the
pins list's `small` row. Every chat draws it: a stream's, a group channel's, a direct message.
One an admin took down (its poster goes with it) says "removed" instead; one this viewer may not
see says so.
