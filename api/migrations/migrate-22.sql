-- the search's filters (docs/chat.md): `has:image` and `has:link` read a room through these,
-- and do not scan it for the few lines that have one. a link is what the panel draws as one:
-- http(s)://, or www., at the start of a word. `has:video` is a link to a video, read out of
-- the linked lines by the chat process (history.rs VIDEO_LINK), so the hosts can change
-- without another file here.
ALTER TABLE chat_lines ADD COLUMN has_link boolean GENERATED ALWAYS AS ("text" ~* '(^|[^[:alnum:]])(https?://|www\.)[^[:space:]]') STORED;

CREATE INDEX chat_lines_image_idx ON chat_lines (room, at, seq) WHERE image IS NOT NULL;
CREATE INDEX chat_lines_link_idx ON chat_lines (room, at, seq) WHERE has_link;
