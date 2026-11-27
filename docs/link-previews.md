# link previews

A chat line (a stream's chat, a group channel, a DM) whose text has an `http(s)` link gets a preview card under it: the site's name, the page's title (a link to the page), up to four lines of its description, and its picture. Only the first link of a line counts. A link the chat already plays inline (`ChatEmbeds`: youtube, vimeo, twitch, streamable, dailymotion, tiktok, a `.mp4`/`.webm`/`.mov` file) gets no card.

## how a card is made

1. The line is said as before (`chat::accept`, `dms::send`). Nothing waits on the page.
2. If the sayer is logged in and the line's first link passes the url guard (`unfurl::wanted`), a job goes on the redis list `unfurl:jobs` (`LPUSH`, kept to 1000, an hour's ttl). The chat service has no s3 and no moderation, so it only queues.
3. The api runs the worker (`unfurl::spawn_worker`, started in `main`): `BRPOP` on its own redis connection, four jobs at once, 30 s each at most, a job older than two minutes is dropped.
4. The page: redis cache `unfurl:page:<sha256 of the url>` (24 h; a miss or a failure is cached as `-` for 1 h). On a cache miss the sayer's `rl:unfurl:<id>` counts, 20 a minute; over it the line gets no card. Then `ssrf::fetch` and `og::parse`.
   A wikipedia article (`https://<lang>.wikipedia.org/wiki/<Title>`, or the `<lang>.m.` host; not `Special:`, `Talk:`, `File:` and the other namespaces, not `/w/index.php`) is read from the Wikimedia REST summary instead (`wiki::summary_url`: `https://<lang>.wikipedia.org/api/rest_v1/page/summary/<Title>`, through the same guard, caps and user agent): the title (`displaytitle` stripped of tags, else `title`), the lead `extract` as the description, `thumbnail.source` (else `originalimage.source`) as the picture, and `Wikipedia` as the site. If that fails the page itself is read as for any other link.
5. The picture (`og:image`, else `og:image:url`/`og:image:secure_url`, else `twitter:image`): fetched through the same guard (png, jpeg, webp or gif, 4 MB at most, refused past that), decoded with size limits, shrunk to 864 px on its long side, re-encoded as a still jpeg (or a lossless webp when it is see-through) of 256 KB at most, and stored with `chat_images::store`: the chat picture path, so it is the same s3 key scheme, the same `chat_images` row and the same moderation (`moderate::check`, counted on the sayer). A picture flagged nsfw or graphic, or unchecked while checks are on, is discarded and the card goes without one. It is marked posted to the line's place, so it is seen by exactly who sees the line (`/api/chat-images/<id>`). It is cached per place: `unfurl:img:<place>:<sha256 of the picture url>`.
6. The card is stored and sent live:
   - a room line: a row in `chat_embeds (room, line_id, embed, hidden)` (migration `0023-link-embeds`), then an entry `emb=<id>, e=<json>` on the room's `chatr:<room>` stream, which the chat reader turns into an `embed` frame (`{ type: "embed", id, embed }`, with `channel` on a group socket and `topic` on rt).
   - a DM: `dms.embed`, then a `dm_embed` fact to both (`{ type: "dm_embed", id, from, to, embed }`).
   The newest lines live in the redis stream and `chat_lines` is written only with `CHAT_PERSIST`, so a room line's card sits beside it in its own table, as reactions do (`chat_reactions`); every place that hands out lines with reactions hands out their cards too (`unfurl::with_embeds`: pages, history, search, the fill after a reconnect, pins).

All text in a card is plain text: entities decoded, tags stripped, control and invisible characters out, white space collapsed, the title cut at 200 characters, the description at 500, the site at 80. `color` is the page's `theme-color` when it is `#rgb` or `#rrggbb`.

## hiding a card

- `POST /api/streams/{name}/chat/{id}/embed/hide`: the line's sayer, or a stream moderator who outranks them (the line delete's rule).
- `POST /api/groups/{group}/channels/{channel}/messages/{id}/embed/hide`: whoever may delete the line (`group_mod::removable`).
- `POST /api/dm/{name}/embed/hide` with `{ id }`: only the line's sender.

A hidden card is kept as `hidden` (a room line) or `embed_hidden` (a DM), so a late worker never puts it back, and the same `embed`/`dm_embed` frame goes out with `embed: null`.

## the url guard (`ssrf.rs`)

- `http` and `https` only, port 80 or 443 (written or not), no user or password, 2048 characters at most.
- the host is read after `url` parses it, so `2130706433`, `0x7f000001`, `0177.0.0.1` and `127.1` are all `127.0.0.1`. An ip host must be public. A name must have a dot and must not be `localhost` or end in `.localhost`, `.local`, `.internal`, `.intranet`, `.lan`, `.home.arpa` or `.localdomain`.
- the client resolves names itself (`Pinned`, a reqwest dns resolver) and refuses the name if any address it got is not public: v4 `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.31.196/24`, `192.52.193/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/3` (multicast, reserved, broadcast); v6 anything outside `2000::/3`, plus `2001::/23`, `2001:db8::/32`, `3fff::/20`; `::ffff:a.b.c.d`, `::a.b.c.d`, `64:ff9b::/96` and `2002::/16` are judged by the v4 inside. reqwest connects only to the addresses that resolver handed back, so a name cannot change between the check and the connect.
- no proxy, no cookies, no automatic redirects: at most three are followed by hand, each new url going through the whole guard again.
- 5 s for the whole fetch, 2 s to connect, `User-Agent: slop-unfurl/1.0 (+https://nodentity.xyz)`. A page must be `text/html` or `application/xhtml+xml` and is read up to 512 KB, then reading stops.

## turning it off

`UNFURL=off` (or `0`, `false`, `no`) on the api stops the worker, and on the chat service stops the queueing. It is on when unset. The api needs a route out to the internet and working dns; nothing else.

## the card in the app

`LinkEmbed` (`shared-components/LinkEmbed.tsx`) sits under the line's pictures, video, voice message and players in every chat: a stream's chat and a group's (`ChatPanel`'s `ChatRow`), a DM (`FriendChat`'s `DmRow`, the phone's too) and a group's pins list (no hide button there). Its text is text nodes only. The title is an `ExternalLink`, so the leave-site word covers it. The picture is lazy and sits in a box with the stored width and height as its aspect ratio (320 px tall at most), so nothing moves when it loads; a picture that fails is dropped and the card stays. The card is 27rem wide at most and the whole width on a phone; in a bubble it loses its own border and fill and takes the bubble's width. A `color` is a 2px left edge. A card with neither title nor description, a link the chat plays inline, or the `show embeds` setting off draws nothing.

The `×` (a boxed button, tooltip `hide embed`) shows for the line's sayer and for whoever may remove the line: `ChatPanel`'s `embedMod` (the watch page and the streamer's own chat module pass it for a moderator; a group passes it when `lineModItems` has `delete`). It hides at once and puts the card back with the api's words if the api says no.

`infra/link-embed.ts` reads a card off the wire (`linkEmbedOf`, through `fromWire` and the DM `lineOf`) and finds a line's first link (`firstLink`); `tests/link-embed.test.ts` covers both.

Hooks for a browser test: the card is `[data-link-embed]` (its value is the host), inside the line's `[data-id="<line id>"]`; then `[data-embed-site]`, `a[data-embed-title]`, `[data-embed-description]`, `[data-embed-image] img`, and `button[data-embed-hide][aria-label="hide embed"]`. In the pins list it is inside `[data-pin-embed="<line id>"]`.
