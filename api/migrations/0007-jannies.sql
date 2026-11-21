-- Jannies (docs/jannies.md): who may clean a stream's chat, the bans and timeouts they hand out,
-- and what they did. Additive: new tables, nothing else touched.
--
-- A stream is its `streamers` row (`stream_id`), never its name, so a rename keeps its jannies,
-- its bans and its log; the people are accounts the same way.

-- A site janny: may delete, ban and time out in every stream's chat. Added by an admin.
CREATE TABLE site_jannies (
    user_id uuid PRIMARY KEY REFERENCES streamers(id) ON DELETE CASCADE,
    by_id uuid REFERENCES streamers(id) ON DELETE SET NULL,
    added_at timestamptz DEFAULT now() NOT NULL
);

-- A stream janny: the same, in one stream's chat. Added by the streamer (or an admin).
CREATE TABLE stream_jannies (
    stream_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    by_id uuid REFERENCES streamers(id) ON DELETE SET NULL,
    added_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (stream_id, user_id)
);
CREATE INDEX stream_jannies_user_idx ON stream_jannies (user_id);

-- No line from `user_id` in the stream's chat, no reaction either, until lifted.
CREATE TABLE stream_bans (
    stream_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    by_id uuid REFERENCES streamers(id) ON DELETE SET NULL,
    reason text DEFAULT '' NOT NULL,
    banned_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (stream_id, user_id)
);

-- The same until `until`. An expired row is the same as none, and is swept at the next timeout.
CREATE TABLE stream_timeouts (
    stream_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    until timestamptz NOT NULL,
    by_id uuid REFERENCES streamers(id) ON DELETE SET NULL,
    PRIMARY KEY (stream_id, user_id)
);

-- What was done in a stream's chat, and by whom: a deleted line keeps its copy here (`snapshot`,
-- the line's json as the chat had it), a ban, a timeout and their lifting a row each.
CREATE TABLE mod_log (
    id bigserial PRIMARY KEY,
    stream_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    actor_id uuid REFERENCES streamers(id) ON DELETE SET NULL,
    actor_name text NOT NULL,
    action text NOT NULL,
    target_id uuid REFERENCES streamers(id) ON DELETE SET NULL,
    target_name text DEFAULT '' NOT NULL,
    line_id text,
    snapshot jsonb,
    at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX mod_log_stream_idx ON mod_log (stream_id, at DESC);
