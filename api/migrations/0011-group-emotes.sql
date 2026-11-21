-- A group's custom emotes (docs/chat.md "emotes"), discord's server emoji. Additive: one new table.
--
-- One row is one picture under one name in one group: `<:name:id>` in a line's text is drawn as it,
-- for a sender who is a member (emotes.rs). The name is `[a-z0-9_]`, 2 to 32, once per group; the
-- picture is a 128x128 webp the api drew itself, in the bucket at `key`. Who uploaded it is an
-- account, read back under the name it has now. A group holds 50 at most (the api's cap).
CREATE TABLE group_emotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_name text NOT NULL,
    name text NOT NULL,
    key text NOT NULL,
    created_by uuid,
    created_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (group_name, name),
    FOREIGN KEY (group_name) REFERENCES groups(name) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES streamers(id) ON DELETE SET NULL
);
