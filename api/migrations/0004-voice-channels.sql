-- Voice channels (voice phase 1). Additive: two columns on channels and one new table.
--
-- A channel is text or voice. Every channel there is now is text, and general always is. A voice
-- channel's `user_limit` is how many may be in it at once, 0 for no limit; a text channel keeps 0.

ALTER TABLE channels
    ADD COLUMN kind text DEFAULT 'text' NOT NULL CHECK (kind IN ('text', 'voice')),
    ADD COLUMN user_limit integer DEFAULT 0 NOT NULL;

-- One row is one account's one stay in a voice channel, from join to leave; `left_at` is null while
-- they are still in. It goes with its channel, follows it through a rename, and goes with the
-- account. Read newest first per account.
CREATE TABLE voice_sessions (
    id bigserial PRIMARY KEY,
    server text NOT NULL,
    channel text NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamptz DEFAULT now() NOT NULL,
    left_at timestamptz,
    FOREIGN KEY (server, channel) REFERENCES channels(server, name) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES streamers(id) ON DELETE CASCADE
);
CREATE INDEX voice_sessions_user_idx ON voice_sessions (user_id, joined_at DESC);
