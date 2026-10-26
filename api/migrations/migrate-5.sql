-- a chat line, written by the chat process when CHAT_PERSIST is on. the api creates
-- the table and never serves it. id is the redis stream id, unique per room, not across
-- rooms. at and seq are that id as numbers: the text does not sort.

CREATE TABLE chat_lines (
    room text NOT NULL,
    id text NOT NULL,
    at timestamptz NOT NULL,
    seq bigint NOT NULL,
    speaker text NOT NULL,
    user_id uuid REFERENCES streamers(id) ON DELETE SET NULL,
    "text" text NOT NULL,
    streamer boolean NOT NULL,
    verified boolean NOT NULL,
    badges jsonb NOT NULL DEFAULT '[]'::jsonb,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED,
    PRIMARY KEY (room, id)
);

CREATE INDEX chat_lines_room_idx ON chat_lines (room, at, seq);
CREATE INDEX chat_lines_user_idx ON chat_lines (user_id, room, at, seq);
CREATE INDEX chat_lines_search_idx ON chat_lines USING gin (search);
