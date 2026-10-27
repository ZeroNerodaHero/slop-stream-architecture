-- direct messages (docs/dms.md): a login writes a line to a friend, someone it follows who
-- follows it back. both sides are the account id (docs/ids.md), so a rename keeps the thread
-- and a line is shown under whatever name its writer has now. a thread is the pair whichever
-- way round, so the thread index puts the two ids in one order.

CREATE TABLE dms (
    id bigserial PRIMARY KEY,
    from_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    to_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    text text NOT NULL,
    sent_at timestamptz NOT NULL DEFAULT now(),
    CHECK (from_id <> to_id)
);

-- one thread, newest first, whichever way each line went
CREATE INDEX dms_thread_idx ON dms (LEAST(from_id, to_id), GREATEST(from_id, to_id), id DESC);
-- everything a login sent, and everything sent to it: the list of threads, and the count of what is new
CREATE INDEX dms_from_idx ON dms (from_id, id DESC);
CREATE INDEX dms_to_idx ON dms (to_id, id DESC);

-- how far into each thread a login has read: the last line id it saw. what is new is every
-- line from the peer past it. kept per reader, so the count holds across reloads and devices.
CREATE TABLE dm_reads (
    reader_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    peer_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    last_read_id bigint NOT NULL,
    read_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (reader_id, peer_id)
);
