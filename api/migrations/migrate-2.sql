-- groups, who is in them, and the pictures a home card can show. bot is built in.

CREATE TABLE groups (
    name text PRIMARY KEY,
    badge text NOT NULL,
    color text NOT NULL,
    about text NOT NULL DEFAULT '',
    created_by text REFERENCES streamers(name) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
    name text NOT NULL REFERENCES streamers(name) ON DELETE CASCADE,
    group_name text NOT NULL REFERENCES groups(name) ON DELETE CASCADE,
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (name, group_name)
);

CREATE INDEX memberships_group_idx ON memberships (group_name);

INSERT INTO groups (name, badge, color, about)
    VALUES ('bot', 'BOT', '#5865f2', 'automatic. the fake streams'' pretend chatters, and any chat socket that says it is one. nobody joins it.');

CREATE TABLE stream_thumbs (
    name text NOT NULL,
    id bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (name, id)
);
