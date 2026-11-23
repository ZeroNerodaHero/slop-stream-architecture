-- Stream analytics, the first version (docs/analytics.md). Three tables, all additive, kept
-- forever: nothing deletes from them but an account going (its streams go with it).
--
-- `stream_sessions`: one row per stream an account made, the same id as its `sessions` row (the
-- go-live grant's session). Only an account's streams: a free name's are nobody's to read. Opened
-- at go-live; `ended_at` follows the `sessions` row once that ends (stop, video, the sweeper), so
-- every way a stream ends reaches it, even one that happened while this api was down.
-- `peak_viewers` is the highest count video reported, which is finer than the samples.
CREATE TABLE stream_sessions (
    id bigint NOT NULL,
    streamer uuid NOT NULL,
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    peak_viewers integer DEFAULT 0 NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (streamer) REFERENCES streamers(id) ON DELETE CASCADE
);
CREATE INDEX stream_sessions_streamer_idx ON stream_sessions (streamer, started_at DESC);
CREATE INDEX stream_sessions_open_idx ON stream_sessions (id) WHERE ended_at IS NULL;

-- `viewer_samples`: how many were watching, once a minute while live. `ts` is the minute (the
-- sampler truncates), so two api processes sampling the same minute write one row. The primary
-- key is the (session_id, ts) index the graph reads by.
CREATE TABLE viewer_samples (
    session_id bigint NOT NULL,
    ts timestamptz NOT NULL,
    viewers integer NOT NULL,
    PRIMARY KEY (session_id, ts),
    FOREIGN KEY (session_id) REFERENCES stream_sessions(id) ON DELETE CASCADE
);

-- `watch_sessions`: one stretch of one viewer watching one stream. `viewer` is the login's id, or
-- the browser's random anonymous id when `anon`. `left_at` is the last beat the watch page sent
-- (every minute while the video plays, and once more on leaving), so a row is never left open:
-- a tab that died, or an api restart, leaves the row ending at its last beat.
CREATE TABLE watch_sessions (
    session_id bigint NOT NULL,
    viewer uuid NOT NULL,
    joined_at timestamptz NOT NULL,
    left_at timestamptz NOT NULL,
    anon boolean NOT NULL,
    PRIMARY KEY (session_id, viewer, joined_at),
    FOREIGN KEY (session_id) REFERENCES stream_sessions(id) ON DELETE CASCADE
);
