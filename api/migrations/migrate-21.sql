-- a line in a group's channel is a row of the inbox too (docs/notifications.md, the `chat`
-- kind): for every member of the server but the speaker, one unread row a channel, the newest
-- line's words in `text` and the room (`<server>/<channel>`, the chat's key) in `room`. null
-- on every other kind.
ALTER TABLE notifications ADD COLUMN room text;

-- a login that has muted a channel gets no row for its lines. per channel, not per group:
-- a noisy #clips is put away and #general still reaches the bell. gone with the channel,
-- and with the group through it.
CREATE TABLE channel_mutes (
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    server text NOT NULL,
    channel text NOT NULL,
    muted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, server, channel),
    FOREIGN KEY (server, channel) REFERENCES channels(server, name) ON DELETE CASCADE
);
