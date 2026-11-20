-- A group channel's pinned lines (docs/groups.md "pins"). The line is kept as it was said
-- (`line`, the chat's json for it, and `speaker_id`, the account behind a login's line, for its
-- face as it is now), so a pin outlives the room's stream trimming it. The pin goes with its
-- channel, and follows it through a rename.
CREATE TABLE channel_pins (
    server text NOT NULL,
    channel text NOT NULL,
    message_id text NOT NULL,
    line jsonb NOT NULL,
    speaker_id uuid,
    pinned_by uuid,
    pinned_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (server, channel, message_id),
    FOREIGN KEY (server, channel) REFERENCES channels(server, name) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (speaker_id) REFERENCES streamers(id) ON DELETE SET NULL,
    FOREIGN KEY (pinned_by) REFERENCES streamers(id) ON DELETE SET NULL
);
CREATE INDEX channel_pins_newest_idx ON channel_pins (server, channel, pinned_at DESC);
