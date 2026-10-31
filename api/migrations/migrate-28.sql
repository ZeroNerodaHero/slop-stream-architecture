-- a role's cooldown (docs/groups.md): seconds its holders wait between lines in the group's channels,
-- 0 (off) unless a role says otherwise. a member with several roles waits the longest of them; the
-- owners and a site admin wait for nobody.
ALTER TABLE roles ADD COLUMN cooldown integer NOT NULL DEFAULT 0;

-- a member timed out (the kick power): no line of theirs in the group's channels until `until`. a row
-- of its own, not a column of memberships, so leaving and joining again does not end it. an expired
-- row is nothing, and is swept when the next one is written. gone with the group and the account.
CREATE TABLE timeouts (
    group_name text NOT NULL REFERENCES groups(name) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    until timestamptz NOT NULL,
    by_id uuid REFERENCES streamers(id) ON DELETE SET NULL,
    PRIMARY KEY (group_name, user_id)
);
