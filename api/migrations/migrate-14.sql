-- notifications (docs/notifications.md): a login's inbox of what happened to them while they
-- were or were not looking. someone they follow went live (`live`, with the session, so a
-- publish video retries makes one row, not three), someone followed them (`follow`), a friend
-- wrote (`dm`, the line's words in `text`). `actor_id` is who did it, by row id (docs/ids.md),
-- so a rename shows under the name they have now. the api writes the row and a `notify`
-- fact; the gateway pushes it to the login's own sockets; the bell at the top right lists
-- them. the last 30 a login are kept, older rows go with every write. `read_at` is when the
-- login saw it: opening the list reads everything up to the newest.

CREATE TABLE notifications (
    id bigserial PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    kind text NOT NULL,
    actor_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    session bigint,
    text text NOT NULL DEFAULT '',
    at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);

-- which kinds a login wants kept, the user modal's notifications tab: a json document of the
-- kinds turned off (`{"live": false}`); a kind not in it is on. nothing is written for a guest.
ALTER TABLE streamers ADD COLUMN notify jsonb NOT NULL DEFAULT '{}'::jsonb;
