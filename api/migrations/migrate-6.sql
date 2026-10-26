-- a group's channels. the group is the server. bot is not one.
-- general is the first channel, including for every server that already exists.

CREATE TABLE channels (
    server text NOT NULL REFERENCES groups(name) ON DELETE CASCADE,
    name text NOT NULL,
    about text NOT NULL DEFAULT '',
    created_by_id uuid REFERENCES streamers(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (server, name)
);

INSERT INTO channels (server, name, about)
    SELECT name, 'general', '' FROM groups WHERE name <> 'bot';
